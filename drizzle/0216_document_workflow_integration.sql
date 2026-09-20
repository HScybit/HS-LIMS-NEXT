-- Step 10g part 2: Document Management's approval-workflow integration —
-- extends the shared workflow/approval engine (previously scoped to
-- 'sample'/'test_request'/'instrument_service') with a third owner type,
-- 'document'. This required a full audit of every place that assumed
-- exactly two owner types before writing a single line here; see
-- .local-migration/PENDING_DECISIONS.md for the complete blast-radius map.
--
-- IMPORTANT correction to that audit's own framing: laboratory_can_read()
-- and the samples.manage/test_requests.allocate/datasheets.execute
-- permission-triple SQL functions are SHARED across many unrelated tables
-- (samples, test_requests, datasheets, sample_products, sample_tests,
-- analytical_specifications, etc. — see \d+ on any of them). Modifying
-- those functions directly would grant a documents-only actor read/write
-- access to all of those unrelated tables too — a real privilege
-- escalation. The correct, precisely-scoped fix is to extend the
-- PER-TABLE POLICIES on only the workflow/approval tables (RLS policies
-- are independent objects per table even when they share a name), leaving
-- the shared functions and every other table's own policy untouched.

-- 1. document_categories gets an optional workflow link (a document's
-- workflow is tied to its category, mirroring Meteor's own per-category
-- workflow_id — not the sample-category "default workflow mapping" system,
-- which is a different, more complex concept this doesn't need).
ALTER TABLE document_categories ADD COLUMN workflow_id uuid;
ALTER TABLE document_categories ADD CONSTRAINT document_category_workflow_fk FOREIGN KEY(organization_id,workflow_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
-- 2. workflow_runs gains a third owner column. Every new version of a
-- document gets its own fresh workflow run (mirroring Meteor: a new
-- version starts its own approval cycle rather than inheriting the
-- previous version's approved state).
ALTER TABLE workflow_runs ADD COLUMN document_id uuid;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_run_document_fk FOREIGN KEY(organization_id,document_id) REFERENCES documents(organization_id,id);
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_run_document_key UNIQUE(organization_id,document_id);
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_run_owner;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_run_owner CHECK (num_nonnulls(sample_id,test_request_id,document_id)=1);
--> statement-breakpoint
-- 3. 'document' joins the applies_to whitelist everywhere it's currently
-- enforced: the two live CHECK constraints (workflows.workflow_metadata,
-- workflow_metadata_versions.workflow_metadata_history_fields — both from
-- drizzle/0192, confirmed the true latest by grep across all 215
-- migrations) and the workflows_metadata_write() validation function that
-- backs the actual create/update API path.
-- Exact prior definitions verified live via pg_get_constraintdef before
-- writing this (not reconstructed from memory) — only 'document' is added
-- to the two applies_to whitelists; everything else is unchanged.
ALTER TABLE workflows DROP CONSTRAINT workflow_metadata;
ALTER TABLE workflows ADD CONSTRAINT workflow_metadata CHECK (length(trim(code)) between 1 and 64 and length(trim(name)) between 1 and 200
  and applies_to in ('sample', 'test_request', 'instrument_service', 'document'));
ALTER TABLE workflow_metadata_versions DROP CONSTRAINT workflow_metadata_history_fields;
ALTER TABLE workflow_metadata_versions ADD CONSTRAINT workflow_metadata_history_fields CHECK (
  length(trim(code)) between 1 and 64 and length(trim(name)) between 1 and 200
  and applies_to in ('sample', 'test_request', 'instrument_service', 'document')
  and (requested_applies_to is null or requested_applies_to in ('sample', 'test_request', 'instrument_service', 'document'))
  and (not generated_code or (operation='create' and requested_code is not null))
  and (operation<>'retire' or (not active and not description_provided and not generated_code and num_nonnulls(requested_code,requested_applies_to,requested_active)=0)));
--> statement-breakpoint
-- Exact original signature verified via pg_get_function_arguments before
-- writing this (parameter order/names, not just the body, since a
-- CREATE OR REPLACE with a mismatched signature creates a second, ambiguous
-- overload instead of replacing the original — caught by the full
-- regression run, not by inspection alone). The RETURNS TABLE column names
-- are part of the function's OUT-parameter identity too (42P13 if
-- mismatched) — verified against drizzle/0192_instrument_master_core.sql's
-- original definition: first column is named metadata_revision, not revision.
CREATE OR REPLACE FUNCTION workflows_metadata_write(operation text, target uuid, expected_revision integer, requested_id uuid,
  requested_name text, requested_description text, description_provided boolean, requested_code text, generate_code boolean,
  requested_type text, requested_active boolean) RETURNS TABLE(metadata_revision integer, initial_version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
    OR (requested_type IS NOT NULL AND requested_type NOT IN ('sample','test_request','instrument_service','document'))
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
        AND target IN (test_request_workflow_id,job_workflow_id,sample_workflow_base_id,sample_workflow_iqc_id,sample_workflow_ilc_id,sample_workflow_pt_id,sample_workflow_amendment_id,sample_workflow_complaint_id))
      OR EXISTS (SELECT 1 FROM public.document_categories WHERE organization_id=org AND workflow_id=target) INTO used;
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
-- 4. laboratory_guard_workflow_run(): the BEFORE INSERT/UPDATE trigger on
-- workflow_runs itself — the single highest-risk item, since it blocks
-- EVERY insert/update to this table, not just document ones. The 3-way
-- CASE and the added document_id column in the immutability tuple are the
-- only changes; everything else is byte-for-byte the version this
-- replaces (drizzle/0013, never redefined since).
CREATE OR REPLACE FUNCTION laboratory_guard_workflow_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT w.applies_to INTO owner_type FROM public.workflow_versions v JOIN public.workflows w
      ON w.organization_id = v.organization_id AND w.id = v.workflow_id
      JOIN public.workflow_states s ON s.organization_id = v.organization_id AND s.workflow_version_id = v.id
      WHERE v.organization_id = NEW.organization_id AND v.id = NEW.workflow_version_id AND v.status = 'published' AND w.active
        AND s.id = NEW.current_state_id AND s.state_type = 'initial';
    IF owner_type IS DISTINCT FROM (CASE WHEN NEW.sample_id IS NOT NULL THEN 'sample' WHEN NEW.document_id IS NOT NULL THEN 'document' ELSE 'test_request' END)
      OR NEW.revision <> 1 OR NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Workflow run requires a published initial state for its owner type' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.workflow_version_id, NEW.sample_id, NEW.test_request_id, NEW.document_id, NEW.started_by, NEW.started_at)
      IS DISTINCT FROM (OLD.workflow_version_id, OLD.sample_id, OLD.test_request_id, OLD.document_id, OLD.started_by, OLD.started_at)
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Workflow run identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 5. workflow_lock_run(): the ELSE branch silently no-ops for a document
-- run today (test_request_id is null, so it locks nothing and never
-- raises) — a real concurrency hole, not just a missing feature. Adding
-- the document branch is the only change; the permission check and the
-- rest of the function are byte-for-byte the version this replaces
-- (latest at drizzle/0198).
CREATE OR REPLACE FUNCTION workflow_lock_run(selected_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; run public.workflow_runs;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
    OR public.app_has_permission('approvals.respond') OR public.app_has_permission('documents.manage')) THEN
    RAISE EXCEPTION 'Workflow action permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  IF run.id IS NULL THEN RETURN false; END IF;
  IF run.sample_id IS NOT NULL THEN
    PERFORM 1 FROM public.samples WHERE organization_id=org AND id=run.sample_id FOR UPDATE;
  ELSIF run.document_id IS NOT NULL THEN
    PERFORM 1 FROM public.documents WHERE organization_id=org AND id=run.document_id FOR UPDATE;
  ELSE
    PERFORM public.laboratory_lock_request_sample(run.test_request_id);
    PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=run.test_request_id FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.workflow_runs WHERE organization_id=org AND id=selected_run FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.laboratory_job_workflow_effects effect
    WHERE effect.organization_id=org AND effect.child_workflow_run_id=selected_run AND effect.is_current
      AND effect.action<>'rejected' AND effect.target_state_type NOT IN ('final','cancelled')) THEN
    RAISE EXCEPTION 'Continue this review from the parent job' USING ERRCODE='23514', CONSTRAINT='workflow_parent_job_controls';
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint
-- 6. workflow_can_request(): adds documents.manage to the same permission
-- check already used for samples/test-requests requesting a no-approval
-- transition. Everything else is unchanged from its only-ever definition.
CREATE OR REPLACE FUNCTION workflow_can_request(selected_transition uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
      OR public.app_has_permission('approvals.respond') OR public.app_has_permission('documents.manage'))
    AND EXISTS (SELECT 1 FROM public.workflow_transitions transition
      WHERE transition.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND transition.id=selected_transition
      AND (NOT EXISTS (SELECT 1 FROM public.workflow_transition_creator_roles creator WHERE creator.organization_id=transition.organization_id AND creator.transition_id=transition.id)
        OR EXISTS (SELECT 1 FROM public.workflow_transition_creator_roles creator JOIN public.membership_roles membership
          ON membership.organization_id=creator.organization_id AND membership.role_id=creator.role_id
          WHERE creator.organization_id=transition.organization_id AND creator.transition_id=transition.id
            AND membership.user_id=nullif(current_setting('app.user_id',true),'')::uuid)))
$$;
--> statement-breakpoint
-- 7. workflow_apply_document_transition(): a new, dedicated function
-- alongside (not replacing) workflow_apply_sample_transition and
-- workflow_apply_test_request_transition, which both explicitly RAISE if
-- their own owner column is null — they will never be reached by a
-- document run as long as applyWorkflowTransition() in requests.js
-- dispatches to this function for document runs instead. Modelled on
-- workflow_apply_sample_transition's structure with the test-request-
-- allocation/approval requirement check and job-effects propagation
-- removed, since neither concept applies to documents.
CREATE FUNCTION workflow_apply_document_transition(selected_run uuid, selected_transition uuid, expected_revision integer, remarks text)
RETURNS TABLE(revision integer, status text, history_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  run public.workflow_runs; transition public.workflow_transitions; target public.workflow_states; approved boolean; next_status text; recorded_history uuid;
BEGIN
  IF NOT public.workflow_lock_run(selected_run) OR actor IS NULL OR length(remarks)>5000 THEN
    RAISE EXCEPTION 'Invalid workflow transition request' USING ERRCODE='42501';
  END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  SELECT * INTO transition FROM public.workflow_transitions WHERE organization_id=org AND id=selected_transition
    AND workflow_version_id=run.workflow_version_id AND source_state_id=run.current_state_id;
  IF run.status<>'active' OR run.revision<>expected_revision OR run.document_id IS NULL OR transition.id IS NULL
    OR EXISTS (SELECT 1 FROM public.approval_cases pending WHERE pending.organization_id=org AND pending.workflow_run_id=run.id AND pending.status='pending') THEN
    RAISE EXCEPTION 'Workflow changed or an approval is pending' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.approval_cases approval JOIN public.approval_stages stage
    ON stage.organization_id=approval.organization_id AND stage.approval_case_id=approval.id
    JOIN public.approval_assignments assignment ON assignment.organization_id=stage.organization_id AND assignment.approval_stage_id=stage.id
    JOIN public.approval_decisions decision ON decision.organization_id=assignment.organization_id AND decision.approval_assignment_id=assignment.id
    WHERE approval.organization_id=org AND approval.workflow_run_id=run.id AND approval.transition_id=transition.id AND approval.run_revision=expected_revision
      AND approval.status='approved' AND approval.resolved_at=transaction_timestamp() AND decision.decided_by=actor AND decision.decided_at=transaction_timestamp()) INTO approved;
  IF NOT ((transition.approval_mode='none' AND public.workflow_can_request(transition.id)) OR (approved AND public.app_has_permission('approvals.respond'))) THEN
    RAISE EXCEPTION 'This transition requires its configured approval' USING ERRCODE='42501';
  END IF;
  IF transition.require_comment AND nullif(trim(remarks),'') IS NULL THEN RAISE EXCEPTION 'A transition comment is required' USING ERRCODE='23514'; END IF;
  SELECT * INTO target FROM public.workflow_states WHERE organization_id=org AND id=transition.target_state_id;
  next_status:=CASE WHEN target.state_type='cancelled' THEN 'cancelled' WHEN target.state_type='final' THEN 'completed' ELSE 'active' END;
  UPDATE public.workflow_runs stored SET current_state_id=target.id, status=next_status, revision=stored.revision+1,
    completed_at=CASE WHEN next_status<>'active' THEN transaction_timestamp() ELSE NULL END WHERE stored.organization_id=org AND stored.id=run.id;
  INSERT INTO public.workflow_run_history(organization_id,workflow_run_id,workflow_version_id,from_state_id,to_state_id,transition_id,action,actor_user_id,comment)
    VALUES(org,run.id,run.workflow_version_id,run.current_state_id,target.id,transition.id,
      CASE WHEN next_status='completed' THEN 'completed' WHEN next_status='cancelled' THEN 'cancelled' WHEN approved THEN 'approved' ELSE 'transitioned' END,actor,remarks) RETURNING id INTO recorded_history;
  RETURN QUERY SELECT expected_revision+1,next_status,recorded_history;
END $$;
GRANT EXECUTE ON FUNCTION workflow_apply_document_transition(uuid,uuid,integer,text) TO sampleify_app;
--> statement-breakpoint
-- 8. RLS: extend only the policies scoped to the workflow/approval tables
-- themselves (7 tables) — never the shared laboratory_can_read()/
-- permission-triple functions those policies call, which are reused by
-- many unrelated tables (samples, test_requests, datasheets, and more).
DROP POLICY laboratory_record_read ON workflow_runs;
DROP POLICY laboratory_record_read ON workflow_run_history;
DROP POLICY approval_read ON approval_cases;
DROP POLICY approval_read ON approval_stages;
DROP POLICY approval_read ON approval_assignments;
DROP POLICY approval_read ON approval_decisions;
DROP POLICY approval_read ON workflow_checklist_answers;
CREATE POLICY laboratory_record_read ON workflow_runs FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
CREATE POLICY laboratory_record_read ON workflow_run_history FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
CREATE POLICY approval_read ON approval_cases FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
CREATE POLICY approval_read ON approval_stages FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
CREATE POLICY approval_read ON approval_assignments FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
CREATE POLICY approval_read ON approval_decisions FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
CREATE POLICY approval_read ON workflow_checklist_answers FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT laboratory_can_read() OR app_has_permission('documents.read') OR app_has_permission('documents.manage')));
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['workflow_runs','workflow_run_history'] LOOP
    EXECUTE format('DROP POLICY laboratory_record_write ON %I', relation);
    EXECUTE format('CREATE POLICY laboratory_record_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'') OR app_has_permission(''documents.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'') OR app_has_permission(''documents.manage'')))', relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['approval_cases','approval_stages','approval_assignments','approval_decisions','workflow_checklist_answers'] LOOP
    EXECUTE format('DROP POLICY approval_write ON %I', relation);
    EXECUTE format('CREATE POLICY approval_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''samples.manage'') OR app_has_permission(''datasheets.execute'') OR app_has_permission(''approvals.respond'') OR app_has_permission(''documents.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''samples.manage'') OR app_has_permission(''datasheets.execute'') OR app_has_permission(''approvals.respond'') OR app_has_permission(''documents.manage'')))', relation);
  END LOOP;
END $$;
