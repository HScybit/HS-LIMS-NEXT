-- Complete the new setting references under the existing workflow retirement protocol.
CREATE OR REPLACE FUNCTION laboratory_guard_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_ids uuid[]; matched integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organization settings cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 THEN RAISE EXCEPTION 'Settings revisions start at one' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.organization_id<>OLD.organization_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Settings identity and revision are invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF session_user='sampleify_app' AND (NEW.updated_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.updated_at IS DISTINCT FROM transaction_timestamp()) THEN
    RAISE EXCEPTION 'Settings changes require the actual actor and time' USING ERRCODE='42501';
  END IF;
  IF NEW.result_summary_template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN public.template_versions version
    ON version.organization_id=template.organization_id AND version.template_id=template.id
    WHERE template.organization_id=NEW.organization_id AND template.id=NEW.result_summary_template_id AND template.active AND version.kind='datasheet')
  THEN RAISE EXCEPTION 'Select an active datasheet summary template' USING ERRCODE='23514'; END IF;
  IF NEW.job_workflow_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflows workflow JOIN public.workflow_versions version
    ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
    WHERE workflow.organization_id=NEW.organization_id AND workflow.id=NEW.job_workflow_id AND workflow.active AND workflow.applies_to='test_request' AND version.status='published')
  THEN RAISE EXCEPTION 'Select a published test request workflow' USING ERRCODE='23514'; END IF;
  SELECT array_agg(DISTINCT selected.next_id) INTO selected_ids FROM unnest(ARRAY[NEW.sample_workflow_base_id,NEW.sample_workflow_iqc_id,NEW.sample_workflow_ilc_id,NEW.sample_workflow_pt_id,NEW.sample_workflow_amendment_id,NEW.sample_workflow_complaint_id],
    CASE WHEN TG_OP='UPDATE' THEN ARRAY[OLD.sample_workflow_base_id,OLD.sample_workflow_iqc_id,OLD.sample_workflow_ilc_id,OLD.sample_workflow_pt_id,OLD.sample_workflow_amendment_id,OLD.sample_workflow_complaint_id] ELSE ARRAY[NULL,NULL,NULL,NULL,NULL,NULL]::uuid[] END) selected(next_id,previous_id)
    WHERE selected.next_id IS NOT NULL AND selected.next_id IS DISTINCT FROM selected.previous_id;
  IF cardinality(selected_ids)>0 THEN
    -- Acquire each workflow lock once, in a consistent order, and recheck after waiting.
    PERFORM 1 FROM public.workflows workflow WHERE workflow.organization_id=NEW.organization_id AND workflow.id=ANY(selected_ids)
      AND workflow.active AND workflow.applies_to='sample' AND EXISTS (SELECT 1 FROM public.workflow_versions version
        WHERE version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published')
      ORDER BY workflow.id FOR SHARE OF workflow;
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>cardinality(selected_ids) THEN
      RAISE EXCEPTION 'Select an active published sample workflow' USING ERRCODE='23514',CONSTRAINT='sample_workflow_active_reference';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workflows_metadata_write(operation text,target uuid,expected_revision integer,requested_id uuid,requested_name text,
  requested_description text,description_provided boolean,requested_code text,generate_code boolean,requested_type text,requested_active boolean)
RETURNS TABLE(metadata_revision integer,initial_version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; head public.workflows;
  prior public.workflow_metadata_versions; next_revision integer; next_code text; next_name text; next_description text; next_type text; next_active boolean;
  created_version uuid; suffix integer:=2; used boolean;
BEGIN
  actor:=public.workflow_metadata_require_actor();
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  actor:=public.workflow_metadata_require_actor();
  IF operation IS NULL OR operation NOT IN ('create','update','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR (operation='create' AND expected_revision<>0)
    OR description_provided IS NULL OR generate_code IS NULL OR (generate_code AND operation<>'create')
    OR (NOT description_provided AND requested_description IS NOT NULL) OR (description_provided AND requested_description IS NULL)
    OR length(requested_description)>10000
    OR (requested_code IS NOT NULL AND (length(trim(requested_code)) NOT BETWEEN 1 AND 64 OR requested_code<>trim(requested_code)))
    OR (requested_type IS NOT NULL AND requested_type NOT IN ('sample','test_request'))
    OR (operation='create' AND (requested_code IS NULL OR requested_type IS NULL))
    OR (operation='retire' AND (num_nonnulls(requested_name,requested_description,requested_code,requested_type,requested_active)<>0 OR description_provided OR generate_code))
    OR (operation<>'retire' AND (requested_name IS NULL OR length(trim(requested_name)) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name))) THEN
    RAISE EXCEPTION 'Invalid workflow metadata command' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_input';
  END IF;
  SELECT * INTO prior FROM public.workflow_metadata_versions history WHERE history.organization_id=org AND history.request_id=requested_id;
  IF FOUND THEN
    IF prior.workflow_id<>target OR prior.operation<>operation OR coalesce(prior.previous_revision,0)<>expected_revision OR prior.saved_by<>actor
      OR prior.description_provided<>description_provided OR prior.generated_code<>generate_code
      OR prior.requested_code IS DISTINCT FROM requested_code OR prior.requested_applies_to IS DISTINCT FROM requested_type
      OR prior.requested_active IS DISTINCT FROM requested_active OR (operation<>'retire' AND prior.name IS DISTINCT FROM requested_name)
      OR (description_provided AND prior.description IS DISTINCT FROM requested_description) THEN
      RAISE EXCEPTION 'Workflow request was already used for a different change' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_request_reused';
    END IF;
    RETURN QUERY SELECT prior.revision,prior.initial_version_id; RETURN;
  END IF;
  SELECT * INTO head FROM public.workflows WHERE organization_id=org AND id=target FOR UPDATE;
  IF operation='create' AND FOUND THEN RAISE EXCEPTION 'Workflow already exists' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_identity_exists'; END IF;
  IF operation<>'create' AND (head.id IS NULL OR NOT head.active) THEN
    RAISE EXCEPTION 'Workflow was not found' USING ERRCODE='P0002',CONSTRAINT='workflow_metadata_not_found';
  END IF;
  IF operation<>'create' AND head.metadata_revision<>expected_revision THEN
    RAISE EXCEPTION 'Workflow details changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_stale';
  END IF;
  next_name:=CASE WHEN operation='retire' THEN head.name ELSE requested_name END;
  next_description:=CASE WHEN description_provided THEN requested_description ELSE coalesce(head.description,'') END;
  next_code:=coalesce(requested_code,head.code); next_type:=coalesce(requested_type,head.applies_to);
  next_active:=CASE WHEN operation='retire' THEN false ELSE coalesce(requested_active,head.active,true) END;
  IF next_active AND (operation='create' OR next_name IS DISTINCT FROM head.name) AND EXISTS (
    SELECT 1 FROM public.workflows WHERE organization_id=org AND id<>target AND active AND name=next_name
  ) THEN RAISE EXCEPTION 'A workflow with this name already exists' USING ERRCODE='23514',CONSTRAINT='workflow_name_exists'; END IF;
  IF generate_code THEN
    WHILE EXISTS (SELECT 1 FROM public.workflows WHERE organization_id=org AND lower(code)=lower(next_code)) LOOP
      next_code:=left(requested_code,60-length(suffix::text))||'-'||suffix::text; suffix:=suffix+1;
    END LOOP;
  END IF;
  IF operation<>'create' AND (NOT next_active OR next_type IS DISTINCT FROM head.applies_to) THEN
    SELECT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_versions version
      ON version.organization_id=run.organization_id AND version.id=run.workflow_version_id WHERE version.organization_id=org AND version.workflow_id=target)
      OR EXISTS (SELECT 1 FROM public.sample_category_workflows WHERE organization_id=org AND workflow_id=target)
      OR EXISTS (SELECT 1 FROM public.organization_laboratory_settings WHERE organization_id=org
        AND target IN (job_workflow_id,sample_workflow_base_id,sample_workflow_iqc_id,sample_workflow_ilc_id,sample_workflow_pt_id,sample_workflow_amendment_id,sample_workflow_complaint_id)) INTO used;
    IF used THEN
      IF NOT next_active THEN RAISE EXCEPTION 'Workflow is currently used' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_in_use';
      ELSE RAISE EXCEPTION 'Used workflow entity type is immutable' USING ERRCODE='23514',CONSTRAINT='workflow_type_in_use'; END IF;
    END IF;
  END IF;
  next_revision:=expected_revision+1;
  IF operation='create' THEN
    INSERT INTO public.workflows(organization_id,id,code,name,description,applies_to,active,metadata_revision,created_by,updated_by,updated_at)
      VALUES(org,target,next_code,next_name,next_description,next_type,next_active,next_revision,actor,actor,transaction_timestamp());
    created_version:=gen_random_uuid();
    INSERT INTO public.workflow_versions(organization_id,id,workflow_id,number,created_by,change_summary)
      VALUES(org,created_version,target,1,actor,'Initial draft');
  ELSE
    UPDATE public.workflows SET code=next_code,name=next_name,description=next_description,applies_to=next_type,active=next_active,
      metadata_revision=next_revision,updated_by=actor,updated_at=transaction_timestamp() WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.workflow_metadata_versions(organization_id,workflow_id,revision,request_id,previous_revision,operation,initial_version_id,
    code,name,description,applies_to,active,requested_code,generated_code,description_provided,requested_applies_to,requested_active,saved_by)
    VALUES(org,target,next_revision,requested_id,CASE WHEN operation='create' THEN NULL ELSE expected_revision END,operation,created_version,
      next_code,next_name,next_description,next_type,next_active,requested_code,generate_code,description_provided,requested_type,requested_active,actor);
  RETURN QUERY SELECT next_revision,created_version;
END $$;
