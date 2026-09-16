-- New writes follow Meteor's dynamic workflow lifecycle. Preserve old native rows
-- as NULL; imported source legacy rows can explicitly carry false. No backfill.
ALTER TABLE test_requests ADD COLUMN using_dynamic_workflow boolean;
--> statement-breakpoint
ALTER TABLE test_requests ALTER COLUMN using_dynamic_workflow SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD COLUMN test_request_workflow_id uuid;
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_request_workflow_fk
  FOREIGN KEY (organization_id,test_request_workflow_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
CREATE FUNCTION laboratory_guard_request_workflow_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' AND session_user='sampleify_app' AND NEW.using_dynamic_workflow IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'New requests require dynamic workflows' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND NEW.using_dynamic_workflow IS DISTINCT FROM OLD.using_dynamic_workflow THEN
    RAISE EXCEPTION 'Request workflow mode is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_test_request_workflow_mode BEFORE INSERT OR UPDATE ON test_requests
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_request_workflow_mode();
--> statement-breakpoint
CREATE FUNCTION laboratory_test_request_workflow(p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; job boolean; selected_id uuid;
BEGIN
  IF org IS NULL OR p_request_id IS NULL OR (NOT public.app_has_permission('test_requests.allocate')
    AND public.laboratory_auto_job_request() IS DISTINCT FROM p_request_id) THEN
    RAISE EXCEPTION 'Request allocation context required' USING ERRCODE='42501';
  END IF;
  SELECT request.is_job INTO job FROM public.test_requests request
    WHERE request.organization_id=org AND request.id=p_request_id AND request.using_dynamic_workflow;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic request allocation context required' USING ERRCODE='42501'; END IF;
  SELECT CASE WHEN job THEN settings.job_workflow_id ELSE settings.test_request_workflow_id END
    INTO selected_id FROM public.organization_laboratory_settings settings WHERE settings.organization_id=org FOR SHARE;
  RETURN selected_id;
END $$;
REVOKE ALL ON FUNCTION laboratory_test_request_workflow(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_test_request_workflow(uuid) TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION laboratory_guard_dynamic_workflow_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_id uuid;
BEGIN
  IF session_user='sampleify_app' AND NEW.test_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.test_request_id AND using_dynamic_workflow) THEN
    selected_id:=public.laboratory_test_request_workflow(NEW.test_request_id);
    PERFORM 1 FROM public.workflows workflow JOIN public.workflow_versions version
      ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
      WHERE workflow.organization_id=NEW.organization_id AND workflow.id=selected_id AND workflow.active
        AND workflow.applies_to='test_request' AND version.id=NEW.workflow_version_id AND version.status='published' FOR SHARE OF workflow;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic requests require the configured published workflow'
      USING ERRCODE='23514',CONSTRAINT='test_request_workflow_binding'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_dynamic_workflow_binding BEFORE INSERT ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_dynamic_workflow_binding();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_guard_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_ids uuid[]; matched integer; retained_common boolean:=false;
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
  IF NEW.result_summary_template_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.result_summary_template_id IS DISTINCT FROM OLD.result_summary_template_id)
    AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN public.template_versions version
    ON version.organization_id=template.organization_id AND version.template_id=template.id
    WHERE template.organization_id=NEW.organization_id AND template.id=NEW.result_summary_template_id AND template.active AND version.kind='datasheet')
  THEN RAISE EXCEPTION 'Select an active datasheet summary template' USING ERRCODE='23514'; END IF;
  -- The source single control synchronizes both keys, including an unchanged
  -- historical selection that became unavailable. Never introduce a new one.
  IF TG_OP='UPDATE' THEN
    retained_common:=coalesce(NEW.test_request_workflow_id=NEW.job_workflow_id
      AND NEW.test_request_workflow_id IN (OLD.test_request_workflow_id,OLD.job_workflow_id),false);
  END IF;
  SELECT array_agg(DISTINCT selected.next_id) INTO selected_ids FROM unnest(
    ARRAY[NEW.test_request_workflow_id,NEW.job_workflow_id],
    CASE WHEN TG_OP='UPDATE' THEN ARRAY[OLD.test_request_workflow_id,OLD.job_workflow_id] ELSE ARRAY[NULL,NULL]::uuid[] END) selected(next_id,previous_id)
    WHERE selected.next_id IS NOT NULL AND selected.next_id IS DISTINCT FROM selected.previous_id AND NOT retained_common;
  IF cardinality(selected_ids)>0 THEN
    PERFORM 1 FROM public.workflows workflow WHERE workflow.organization_id=NEW.organization_id AND workflow.id=ANY(selected_ids)
      AND workflow.active AND workflow.applies_to='test_request' AND EXISTS (SELECT 1 FROM public.workflow_versions version
        WHERE version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published')
      ORDER BY workflow.id FOR SHARE OF workflow;
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>cardinality(selected_ids) THEN
      RAISE EXCEPTION 'Select an active published test request workflow' USING ERRCODE='23514',CONSTRAINT='test_request_workflow_active_reference';
    END IF;
  END IF;
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
CREATE OR REPLACE FUNCTION laboratory_settings_options() RETURNS TABLE(id uuid,kind text,label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('settings.read') OR public.app_has_permission('settings.manage')) THEN
    RAISE EXCEPTION 'Settings permission required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT template.id,'template'::text,latest.name FROM public.templates template
    JOIN LATERAL (SELECT version.name,version.kind FROM public.template_versions version
      WHERE version.organization_id=template.organization_id AND version.template_id=template.id ORDER BY version.number DESC LIMIT 1) latest ON latest.kind='datasheet'
    WHERE template.organization_id=org AND template.active
    UNION ALL SELECT workflow.id,'workflow'::text,workflow.name FROM public.workflows workflow
      WHERE workflow.organization_id=org AND workflow.active AND workflow.applies_to='test_request'
      AND EXISTS (SELECT 1 FROM public.workflow_versions version WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published')
    UNION ALL SELECT workflow.id,'sample_workflow'::text,workflow.name FROM public.workflows workflow
      WHERE workflow.organization_id=org AND workflow.active AND workflow.applies_to='sample'
      AND EXISTS (SELECT 1 FROM public.workflow_versions version WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published')
    UNION ALL SELECT workflow.id,'sample_workflow_retained'::text,workflow.name FROM public.workflows workflow
      JOIN public.organization_laboratory_settings settings ON settings.organization_id=workflow.organization_id
      WHERE workflow.organization_id=org AND workflow.id IN (settings.sample_workflow_base_id,settings.sample_workflow_iqc_id,settings.sample_workflow_ilc_id,settings.sample_workflow_pt_id,settings.sample_workflow_amendment_id,settings.sample_workflow_complaint_id)
      AND NOT (workflow.active AND workflow.applies_to='sample' AND EXISTS (SELECT 1 FROM public.workflow_versions version
        WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published'))
    UNION ALL SELECT workflow.id,'workflow_retained'::text,workflow.name FROM public.workflows workflow
      JOIN public.organization_laboratory_settings settings ON settings.organization_id=workflow.organization_id
      WHERE workflow.organization_id=org AND workflow.id IN (settings.test_request_workflow_id,settings.job_workflow_id)
      AND NOT (workflow.active AND workflow.applies_to='test_request' AND EXISTS (SELECT 1 FROM public.workflow_versions version
        WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published'));
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
        AND target IN (test_request_workflow_id,job_workflow_id,sample_workflow_base_id,sample_workflow_iqc_id,sample_workflow_ilc_id,sample_workflow_pt_id,sample_workflow_amendment_id,sample_workflow_complaint_id)) INTO used;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_complete_job_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_count integer; last_position integer; first_position integer; selected_sample uuid;
  job public.test_requests; settings public.organization_laboratory_settings; analyst uuid; sample_state uuid; summary_template uuid;
BEGIN
  SELECT * INTO job FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=NEW.organization_id FOR SHARE;
  SELECT sample_id INTO selected_sample FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.job_sample_product_id;
  SELECT resolved.template_id INTO summary_template FROM public.laboratory_product_job_templates(selected_sample,ARRAY[job.job_sample_product_id],job.is_auto_created) resolved;
  IF summary_template IS NULL OR job.datasheet_template_id IS DISTINCT FROM summary_template THEN
    RAISE EXCEPTION 'Jobs require the configured organization or product summary template' USING ERRCODE='23514';
  END IF;
  IF job.is_auto_created THEN
    IF NOT settings.auto_create_jobs OR NOT public.laboratory_job_generation_sample(selected_sample) OR job.status<>'created' OR job.revision<>1
      OR EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=job.organization_id AND test_request_id=job.id)
      OR EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=job.organization_id AND test_request_id=job.id)
      OR EXISTS (SELECT 1 FROM public.workflow_runs WHERE organization_id=job.organization_id AND test_request_id=job.id)
    THEN RAISE EXCEPTION 'Automatic jobs stay unassigned until explicit allocation' USING ERRCODE='23514'; END IF;
    analyst:=job.created_by;
  ELSE
  -- Match workflowAllowedActions: a configured allocation capability applies
  -- to this actor; otherwise the allocator permission is the fallback.
  SELECT current_state_id INTO sample_state FROM public.workflow_runs WHERE organization_id=NEW.organization_id AND sample_id=selected_sample;
  IF EXISTS (SELECT 1 FROM public.workflow_state_capability_roles WHERE organization_id=NEW.organization_id AND workflow_state_id=sample_state AND capability='allocate')
    AND NOT EXISTS (SELECT 1 FROM public.workflow_state_capability_roles capability JOIN public.membership_roles role
      ON role.organization_id=capability.organization_id AND role.role_id=capability.role_id
      WHERE capability.organization_id=NEW.organization_id AND capability.workflow_state_id=sample_state AND capability.capability='allocate' AND role.user_id=NEW.created_by)
  THEN RAISE EXCEPTION 'The sample state does not allow this actor to create jobs' USING ERRCODE='42501'; END IF;
  SELECT assigned_user_id INTO analyst FROM public.test_request_assignments
    WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND assignment_type='analyst' AND unassigned_at IS NULL
      AND assigned_by=NEW.created_by AND assigned_at=transaction_timestamp();
  IF job.status<>'allocated' OR analyst IS NULL OR NOT EXISTS (SELECT 1 FROM public.datasheets
    WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND attempt_number=1 AND status='in_progress')
  THEN RAISE EXCEPTION 'A manual job requires its actual analyst and summary capture' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT count(*)::integer,min(job_member_position),max(job_member_position) INTO member_count,first_position,last_position
    FROM public.test_requests WHERE organization_id=NEW.organization_id AND parent_test_request_id=NEW.id;
  IF member_count=0 OR first_position<>0 OR last_position<>member_count-1 THEN
    RAISE EXCEPTION 'A job requires an ordered set of linked requests' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.test_requests member WHERE member.organization_id=NEW.organization_id AND member.parent_test_request_id=NEW.id
    AND ((job.is_auto_created AND NOT public.laboratory_new_generated_request(member.id)) OR member.status<>'allocated' OR NOT EXISTS (SELECT 1 FROM public.test_request_assignments assignment
      WHERE assignment.organization_id=member.organization_id AND assignment.test_request_id=member.id AND assignment.assignment_type='analyst'
        AND assignment.assigned_user_id=analyst AND assignment.unassigned_at IS NULL AND assignment.assigned_by=NEW.created_by AND assignment.assigned_at=transaction_timestamp())
      OR NOT EXISTS (SELECT 1 FROM public.datasheets sheet WHERE sheet.organization_id=member.organization_id AND sheet.test_request_id=member.id AND sheet.attempt_number=1 AND sheet.status='in_progress')))
  THEN RAISE EXCEPTION 'Job members require their actual analyst and individual captures' USING ERRCODE='23514'; END IF;
  IF job.is_auto_created AND EXISTS (SELECT 1 FROM public.test_requests member
    WHERE member.organization_id=job.organization_id AND member.parent_test_request_id=job.id AND member.using_dynamic_workflow
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_versions version
        ON version.organization_id=run.organization_id AND version.id=run.workflow_version_id
        JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.action='started'
        WHERE run.organization_id=member.organization_id AND run.test_request_id=member.id AND version.workflow_id=settings.test_request_workflow_id
          AND run.started_by=job.created_by AND run.started_at=transaction_timestamp() AND history.actor_user_id=job.created_by AND history.occurred_at=transaction_timestamp()))
  THEN RAISE EXCEPTION 'Automatic children require their actual configured initial workflows' USING ERRCODE='23514'; END IF;
  IF job.is_auto_created AND EXISTS (SELECT 1 FROM public.test_requests member
    JOIN public.sample_tests selected ON selected.organization_id=member.organization_id AND selected.id=member.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    JOIN public.sample_category_workflows mapping ON mapping.organization_id=product.organization_id AND mapping.sample_category_id=product.sample_category_id AND mapping.applies_to='test_request' AND mapping.is_default
    JOIN public.workflows workflow ON workflow.organization_id=mapping.organization_id AND workflow.id=mapping.workflow_id AND workflow.active
    JOIN public.workflow_versions version ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published'
    WHERE member.organization_id=job.organization_id AND member.parent_test_request_id=job.id AND member.using_dynamic_workflow IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.action='started'
        WHERE run.organization_id=member.organization_id AND run.test_request_id=member.id AND run.workflow_version_id=version.id
          AND run.started_by=job.created_by AND run.started_at=transaction_timestamp() AND history.actor_user_id=job.created_by AND history.occurred_at=transaction_timestamp()))
  THEN RAISE EXCEPTION 'Automatic children require their actual configured initial workflows' USING ERRCODE='23514'; END IF;
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    VALUES(NEW.organization_id,selected_sample,NEW.id,'test_request_job_created',NEW.created_by,
      format('%s job with %s test request%s.',CASE WHEN job.is_auto_created THEN 'Automatically created' ELSE 'Created' END,member_count,CASE WHEN member_count=1 THEN '' ELSE 's' END));
  RETURN NEW;
END $$;
