-- Automatic jobs are a consequence of actual test-request generation. The
-- triggering actor initializes its new children without gaining allocation
-- permission over existing requests, captures, templates or workflows.
CREATE FUNCTION laboratory_job_generation_sample(p_sample_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; current_state uuid; generates boolean;
BEGIN
  IF org IS NULL OR actor IS NULL OR p_sample_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.sample_events event WHERE event.organization_id=org AND event.sample_id=p_sample_id
      AND event.event_type='test_requests_generated' AND event.actor_user_id=actor AND event.occurred_at=transaction_timestamp()
      AND event.xmin::text=pg_current_xact_id()::text) THEN RETURN false; END IF;
  IF p_sample_id IS NOT DISTINCT FROM public.laboratory_registering_sample()
    OR p_sample_id IS NOT DISTINCT FROM public.workflow_generating_sample() THEN RETURN true; END IF;
  IF NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate')) THEN RETURN false; END IF;
  SELECT run.current_state_id,state.generate_test_requests INTO current_state,generates FROM public.workflow_runs run
    JOIN public.workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE run.organization_id=org AND run.sample_id=p_sample_id;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_state_capability_roles WHERE organization_id=org AND workflow_state_id=current_state AND capability='allocate') THEN RETURN true; END IF;
  RETURN coalesce(generates,false) AND EXISTS (SELECT 1 FROM public.workflow_state_capability_roles capability
    JOIN public.membership_roles role ON role.organization_id=capability.organization_id AND role.role_id=capability.role_id
    WHERE capability.organization_id=org AND capability.workflow_state_id=current_state AND capability.capability='allocate' AND role.user_id=actor);
END $$;
GRANT EXECUTE ON FUNCTION laboratory_job_generation_sample(uuid) TO sampleify_app;

CREATE FUNCTION laboratory_generation_job_settings(p_sample_id uuid) RETURNS TABLE(auto_create_jobs boolean,result_summary_template_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.laboratory_job_generation_sample(p_sample_id) THEN RAISE EXCEPTION 'Actual test request generation is required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT settings.auto_create_jobs,CASE WHEN EXISTS (SELECT 1 FROM public.templates template JOIN public.template_versions version
    ON version.organization_id=template.organization_id AND version.template_id=template.id WHERE template.organization_id=settings.organization_id
      AND template.id=settings.result_summary_template_id AND template.active AND version.kind='datasheet') THEN settings.result_summary_template_id END
    FROM public.organization_laboratory_settings settings
    WHERE settings.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid FOR SHARE OF settings;
END $$;
GRANT EXECUTE ON FUNCTION laboratory_generation_job_settings(uuid) TO sampleify_app;

CREATE FUNCTION laboratory_new_generated_request(p_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public.test_requests request JOIN public.sample_tests selected
    ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    WHERE request.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND request.id=p_request_id AND NOT request.is_job
      AND request.created_by=nullif(current_setting('app.user_id',true),'')::uuid AND request.created_at=transaction_timestamp()
      AND request.xmin::text=pg_current_xact_id()::text AND public.laboratory_job_generation_sample(product.sample_id))
$$;

CREATE FUNCTION laboratory_auto_job_request() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT request.id FROM public.test_requests request JOIN public.test_requests job
    ON job.organization_id=request.organization_id AND job.id=request.parent_test_request_id
    WHERE request.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
      AND request.id=nullif(current_setting('app.auto_job_request_id',true),'')::uuid
      AND public.laboratory_new_generated_request(request.id) AND job.is_job AND job.is_auto_created
      AND job.created_by=request.created_by AND job.created_at=transaction_timestamp() AND job.xmin::text=pg_current_xact_id()::text
$$;
GRANT EXECUTE ON FUNCTION laboratory_auto_job_request() TO sampleify_app;

CREATE FUNCTION laboratory_auto_job_template() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(request.datasheet_template_id,mapping.template_id) FROM public.test_requests request
    JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    LEFT JOIN public.sample_category_templates mapping ON mapping.organization_id=product.organization_id
      AND mapping.sample_category_id=product.sample_category_id AND mapping.purpose='datasheet' AND mapping.is_default
    WHERE request.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND request.id=public.laboratory_auto_job_request()
$$;
GRANT EXECUTE ON FUNCTION laboratory_auto_job_template() TO sampleify_app;

CREATE FUNCTION laboratory_auto_job_capture() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT capture.id FROM public.template_instances capture JOIN public.template_versions version
    ON version.organization_id=capture.organization_id AND version.id=capture.version_id
    WHERE capture.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
      AND capture.id=nullif(current_setting('app.capture_id',true),'')::uuid AND capture.created_by=nullif(current_setting('app.user_id',true),'')::uuid
      AND capture.created_at=transaction_timestamp() AND capture.revision=1 AND capture.status='editing'
      AND version.kind='datasheet' AND version.status='frozen' AND version.template_id=public.laboratory_auto_job_template()
      AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet WHERE sheet.organization_id=capture.organization_id
        AND sheet.template_instance_id=capture.id AND sheet.test_request_id<>public.laboratory_auto_job_request())
$$;
GRANT EXECUTE ON FUNCTION laboratory_auto_job_capture() TO sampleify_app;

CREATE FUNCTION laboratory_start_auto_job(member_ids uuid[]) RETURNS TABLE(id uuid,request_number text,member_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  product_line uuid; selected_sample uuid; settings public.organization_laboratory_settings; job_id uuid:=gen_random_uuid(); job_number text;
BEGIN
  IF member_ids IS NULL OR cardinality(member_ids) NOT BETWEEN 1 AND 500 OR array_position(member_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT member_id) FROM unnest(member_ids) member_id)<>cardinality(member_ids) THEN RAISE EXCEPTION 'Select distinct new requests for an automatic job' USING ERRCODE='23514'; END IF;
  SELECT selected.sample_product_id,product.sample_id INTO product_line,selected_sample FROM public.test_requests request
    JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    WHERE request.organization_id=org AND request.id=member_ids[1];
  IF NOT public.laboratory_job_generation_sample(selected_sample) THEN RAISE EXCEPTION 'Automatic jobs require the actual generation action' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.samples WHERE organization_id=org AND public.samples.id=selected_sample FOR UPDATE;
  PERFORM 1 FROM public.test_requests request WHERE request.organization_id=org AND request.id=ANY(member_ids) ORDER BY request.id FOR UPDATE;
  IF (SELECT count(*) FROM public.test_requests request JOIN public.sample_tests selected
    ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    WHERE request.organization_id=org AND request.id=ANY(member_ids) AND public.laboratory_new_generated_request(request.id)
      AND request.status='created' AND request.parent_test_request_id IS NULL AND selected.sample_product_id=product_line
      AND NOT EXISTS (SELECT 1 FROM public.test_request_assignments assignment WHERE assignment.organization_id=org
        AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL))<>cardinality(member_ids)
  THEN RAISE EXCEPTION 'Automatic jobs can group only their newly generated product-line requests' USING ERRCODE='23514'; END IF;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=org FOR SHARE;
  IF NOT coalesce(settings.auto_create_jobs,false) OR settings.result_summary_template_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.templates template JOIN public.template_versions version ON version.organization_id=template.organization_id AND version.template_id=template.id
    WHERE template.organization_id=org AND template.id=settings.result_summary_template_id AND template.active AND version.kind='datasheet')
  THEN RAISE EXCEPTION 'Automatic job settings are unavailable' USING ERRCODE='23514'; END IF;
  job_number:=public.laboratory_next_number('job',extract(year FROM now() AT TIME ZONE 'UTC')::integer::text);
  INSERT INTO public.test_requests(organization_id,id,request_number,is_job,is_auto_created,job_sample_product_id,priority,due_at,datasheet_template_id,created_by)
    SELECT org,job_id,job_number,true,true,product_line,
      CASE WHEN bool_or(request.priority='urgent') THEN 'urgent' WHEN bool_or(request.priority='high') THEN 'high' ELSE min(request.priority) END,
      min(request.due_at),settings.result_summary_template_id,actor FROM public.test_requests request WHERE request.organization_id=org AND request.id=ANY(member_ids);
  UPDATE public.test_requests request SET parent_test_request_id=job_id,job_member_position=member.ordinality-1,job_linked_by=actor,
    job_linked_at=now(),revision=request.revision+1 FROM unnest(member_ids) WITH ORDINALITY member(member_id,ordinality)
    WHERE request.organization_id=org AND request.id=member.member_id;
  INSERT INTO public.test_request_assignments(organization_id,test_request_id,assignment_type,assigned_user_id,assigned_by)
    SELECT org,member_id,'analyst',actor,actor FROM unnest(member_ids) member_id;
  UPDATE public.test_requests request SET status='allocated',revision=request.revision+1 WHERE request.organization_id=org AND request.id=ANY(member_ids);
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    SELECT org,selected_sample,member_id,'test_request_assigned',actor,'Test request analyst assigned during automatic job creation' FROM unnest(member_ids) member_id;
  RETURN QUERY SELECT job_id,job_number,cardinality(member_ids);
END $$;
GRANT EXECUTE ON FUNCTION laboratory_start_auto_job(uuid[]) TO sampleify_app;

-- The app can initialize only the selected new child's runtime. It receives no
-- allocation UPDATE access to assignments or existing datasheets.
CREATE POLICY auto_job_request_read ON test_requests FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND id=(SELECT laboratory_auto_job_request()));
CREATE POLICY auto_job_sheet_insert ON datasheets FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND test_request_id=(SELECT laboratory_auto_job_request())
    AND created_by=nullif(current_setting('app.user_id',true),'')::uuid AND created_at=transaction_timestamp() AND attempt_number=1);
CREATE POLICY auto_job_sheet_read ON datasheets FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND test_request_id=(SELECT laboratory_auto_job_request()));
CREATE POLICY auto_job_workflow_insert ON workflow_runs FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND test_request_id=(SELECT laboratory_auto_job_request())
    AND sample_id IS NULL AND started_by=nullif(current_setting('app.user_id',true),'')::uuid AND started_at=transaction_timestamp());
CREATE POLICY auto_job_workflow_read ON workflow_runs FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND test_request_id=(SELECT laboratory_auto_job_request()));
CREATE POLICY auto_job_history_insert ON workflow_run_history FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND action='started'
    AND actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND occurred_at=transaction_timestamp()
    AND EXISTS (SELECT 1 FROM workflow_runs run WHERE run.organization_id=workflow_run_history.organization_id AND run.id=workflow_run_history.workflow_run_id
      AND run.test_request_id=(SELECT laboratory_auto_job_request())));
CREATE POLICY auto_job_history_read ON workflow_run_history FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workflow_runs run
    WHERE run.organization_id=workflow_run_history.organization_id AND run.id=workflow_run_history.workflow_run_id AND run.test_request_id=(SELECT laboratory_auto_job_request())));

CREATE POLICY auto_job_capture_insert ON template_instances FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND id=nullif(current_setting('app.capture_id',true),'')::uuid
    AND created_by=nullif(current_setting('app.user_id',true),'')::uuid AND created_at=transaction_timestamp() AND status='editing' AND revision=1
    AND EXISTS (SELECT 1 FROM template_versions version WHERE version.organization_id=template_instances.organization_id AND version.id=template_instances.version_id
      AND version.template_id=(SELECT laboratory_auto_job_template()) AND version.kind='datasheet' AND version.status='frozen'));
CREATE POLICY auto_job_capture_read ON template_instances FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND id=(SELECT laboratory_auto_job_capture()));
CREATE POLICY auto_job_capture_lock ON template_instances FOR UPDATE TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND id=(SELECT laboratory_auto_job_capture())) WITH CHECK (false);
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_occurrences','template_values','datasheet_subjects'] LOOP
    EXECUTE format('CREATE POLICY auto_job_capture_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND instance_id=(SELECT laboratory_auto_job_capture()))',relation);
    EXECUTE format('CREATE POLICY auto_job_capture_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND instance_id=(SELECT laboratory_auto_job_capture()))',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['templates','template_versions','template_sections','template_rows','template_columns','template_fields',
    'template_numeric_config','template_options','template_expressions','template_expression_nodes','template_repeat_groups'] LOOP
    EXECUTE format('CREATE POLICY auto_job_definition_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND %s)',relation,
      CASE WHEN relation='templates' THEN 'id=(SELECT laboratory_auto_job_template())'
        WHEN relation='template_versions' THEN 'template_id=(SELECT laboratory_auto_job_template())'
        ELSE 'version_id IN (SELECT id FROM template_versions WHERE organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND template_id=(SELECT laboratory_auto_job_template()))' END);
  END LOOP;
END $$;

CREATE FUNCTION laboratory_finish_auto_job_member() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; member_id uuid:=public.laboratory_auto_job_request(); next_revision integer;
BEGIN
  IF member_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.template_instances capture
    ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    WHERE sheet.organization_id=org AND sheet.test_request_id=member_id AND sheet.attempt_number=1 AND sheet.status='in_progress'
      AND capture.id=public.laboratory_auto_job_capture()) THEN RAISE EXCEPTION 'The automatic child requires its actual initialized capture' USING ERRCODE='23514'; END IF;
  UPDATE public.test_requests request SET datasheet_template_id=coalesce(request.datasheet_template_id,public.laboratory_auto_job_template()),revision=request.revision+1
    WHERE request.organization_id=org AND request.id=member_id RETURNING revision INTO next_revision;
  RETURN next_revision;
END $$;
GRANT EXECUTE ON FUNCTION laboratory_finish_auto_job_member() TO sampleify_app;

CREATE FUNCTION laboratory_complete_auto_job_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND NOT (public.app_has_permission('datasheets.execute') OR public.app_has_permission('test_requests.allocate') OR public.app_has_permission('samples.manage'))
    AND EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND id=NEW.version_id AND kind='datasheet')
    AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests member ON member.organization_id=sheet.organization_id AND member.id=sheet.test_request_id
      JOIN public.test_requests job ON job.organization_id=member.organization_id AND job.id=member.parent_test_request_id
      WHERE sheet.organization_id=NEW.organization_id AND sheet.template_instance_id=NEW.id AND sheet.created_by=NEW.created_by AND sheet.created_at=NEW.created_at
        AND job.is_job AND job.is_auto_created AND job.created_at=transaction_timestamp() AND public.laboratory_new_generated_request(member.id))
  THEN RAISE EXCEPTION 'Automatic initialization must remain bound to its actual new child' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER auto_job_capture_complete AFTER INSERT ON template_instances DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_complete_auto_job_capture();

-- Forward replacements retain the existing manual job and capture boundaries.
CREATE OR REPLACE FUNCTION laboratory_guard_test_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE specification public.analytical_specifications; selected public.sample_tests; job public.test_requests;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.sample_test_id,NEW.specification_id,NEW.request_number,NEW.attempt_number,NEW.created_by,NEW.created_at,NEW.is_job,NEW.is_auto_created,NEW.job_sample_product_id)
      IS DISTINCT FROM (OLD.sample_test_id,OLD.specification_id,OLD.request_number,OLD.attempt_number,OLD.created_by,OLD.created_at,OLD.is_job,OLD.is_auto_created,OLD.job_sample_product_id)
      OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Test request identity is immutable and revisions are sequential' USING ERRCODE='23514'; END IF;
    IF (NEW.parent_test_request_id,NEW.job_member_position,NEW.job_linked_by,NEW.job_linked_at)
      IS DISTINCT FROM (OLD.parent_test_request_id,OLD.job_member_position,OLD.job_linked_by,OLD.job_linked_at) THEN
      SELECT * INTO job FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.parent_test_request_id FOR UPDATE;
      IF OLD.parent_test_request_id IS NOT NULL OR NEW.parent_test_request_id IS NULL OR OLD.status<>'created' OR NEW.is_job
        OR NOT (public.app_has_permission('test_requests.allocate') OR coalesce(job.is_auto_created AND public.laboratory_new_generated_request(NEW.id),false))
        OR (job.is_auto_created AND NOT public.laboratory_new_generated_request(NEW.id))
        OR NEW.job_linked_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.job_linked_at IS DISTINCT FROM transaction_timestamp()
        OR EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND assignment_type='analyst' AND unassigned_at IS NULL)
      THEN RAISE EXCEPTION 'Only an unallocated request can join a new job' USING ERRCODE='42501'; END IF;
      IF NOT coalesce(job.is_job,false) OR job.created_at IS DISTINCT FROM transaction_timestamp() OR job.created_by IS DISTINCT FROM NEW.job_linked_by
        OR NOT EXISTS (SELECT 1 FROM public.sample_tests WHERE organization_id=NEW.organization_id AND id=NEW.sample_test_id AND sample_product_id=job.job_sample_product_id)
      THEN RAISE EXCEPTION 'Job members must belong to the same product line and creation action' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.datasheet_template_id IS DISTINCT FROM OLD.datasheet_template_id AND
      (OLD.datasheet_template_id IS NOT NULL OR NEW.datasheet_template_id IS NULL OR NOT (public.app_has_permission('test_requests.allocate') OR coalesce(NEW.id=public.laboratory_auto_job_request(),false))
        OR NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.template_instances capture
          ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
          JOIN public.template_versions version ON version.organization_id=capture.organization_id AND version.id=capture.version_id
          WHERE sheet.organization_id=NEW.organization_id AND sheet.test_request_id=NEW.id AND sheet.attempt_number=1 AND version.template_id=NEW.datasheet_template_id))
    THEN RAISE EXCEPTION 'A request template can only be selected during its first allocation' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.status<>'created' OR NEW.revision<>1 OR NEW.parent_test_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Test requests start as ungrouped created records' USING ERRCODE='23514';
    END IF;
    IF NEW.is_job THEN
      IF NOT (public.app_has_permission('test_requests.allocate') OR coalesce(NEW.is_auto_created AND public.laboratory_job_generation_sample((SELECT sample_id FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.job_sample_product_id)),false)) OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
        OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.attempt_number<>1
      THEN RAISE EXCEPTION 'Job creation requires allocation permission and actual provenance' USING ERRCODE='42501'; END IF;
    ELSE
      SELECT * INTO specification FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=NEW.specification_id FOR SHARE;
      SELECT * INTO selected FROM public.sample_tests WHERE organization_id=NEW.organization_id AND id=NEW.sample_test_id;
      IF specification.id IS NULL OR selected.id IS NULL OR (specification.test_parameter_id,specification.method_id,specification.decision_rule_id)
        IS DISTINCT FROM (selected.test_parameter_id,selected.method_id,selected.decision_rule_id)
      THEN RAISE EXCEPTION 'Analytical specification does not match the selected test' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laboratory_complete_job_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_count integer; last_position integer; first_position integer; selected_sample uuid;
  job public.test_requests; settings public.organization_laboratory_settings; analyst uuid; sample_state uuid;
BEGIN
  SELECT * INTO job FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=NEW.organization_id FOR SHARE;
  IF settings.result_summary_template_id IS NULL OR job.datasheet_template_id IS DISTINCT FROM settings.result_summary_template_id THEN
    RAISE EXCEPTION 'Jobs require the configured summary template' USING ERRCODE='23514';
  END IF;
  SELECT sample_id INTO selected_sample FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.job_sample_product_id;
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
    JOIN public.sample_tests selected ON selected.organization_id=member.organization_id AND selected.id=member.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    JOIN public.sample_category_workflows mapping ON mapping.organization_id=product.organization_id AND mapping.sample_category_id=product.sample_category_id AND mapping.applies_to='test_request' AND mapping.is_default
    JOIN public.workflows workflow ON workflow.organization_id=mapping.organization_id AND workflow.id=mapping.workflow_id AND workflow.active
    JOIN public.workflow_versions version ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published'
    WHERE member.organization_id=job.organization_id AND member.parent_test_request_id=job.id
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.action='started'
        WHERE run.organization_id=member.organization_id AND run.test_request_id=member.id AND run.workflow_version_id=version.id
          AND run.started_by=job.created_by AND run.started_at=transaction_timestamp() AND history.actor_user_id=job.created_by AND history.occurred_at=transaction_timestamp()))
  THEN RAISE EXCEPTION 'Automatic children require their actual configured initial workflows' USING ERRCODE='23514'; END IF;
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    VALUES(NEW.organization_id,selected_sample,NEW.id,'test_request_job_created',NEW.created_by,
      format('%s job with %s test request%s.',CASE WHEN job.is_auto_created THEN 'Automatically created' ELSE 'Created' END,member_count,CASE WHEN member_count=1 THEN '' ELSE 's' END));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laboratory_next_number(sequence_name text, period text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; next_number bigint; result_prefix text; width integer;
BEGIN
  IF org IS NULL OR sequence_name IS NULL OR period IS NULL OR period !~ '^[0-9]{4}$'
    OR sequence_name NOT IN ('sample', 'test_request', 'job') THEN RAISE EXCEPTION 'Invalid number sequence' USING ERRCODE = '23514'; END IF;
  IF NOT (sequence_name = 'sample' AND public.app_has_permission('samples.create')
    OR sequence_name <> 'sample' AND (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate') OR public.laboratory_registering_sample() IS NOT NULL OR (sequence_name IN ('test_request','job') AND public.workflow_generating_sample() IS NOT NULL))) THEN
    RAISE EXCEPTION 'Number allocation permission required' USING ERRCODE = '42501';
  END IF;
  result_prefix := CASE sequence_name WHEN 'sample' THEN 'SMP-' WHEN 'test_request' THEN 'TR-' ELSE 'JOB-' END || period || '-';
  INSERT INTO public.number_sequences (organization_id, sequence_key, period_key, prefix, minimum_width)
    VALUES (org, sequence_name, period, result_prefix, CASE sequence_name WHEN 'job' THEN 4 ELSE 6 END) ON CONFLICT DO NOTHING;
  UPDATE public.number_sequences SET next_value = next_value + 1 WHERE organization_id = org AND sequence_key = sequence_name AND period_key = period
    RETURNING next_value - 1, prefix, minimum_width INTO next_number, result_prefix, width;
  RETURN result_prefix || lpad(next_number::text, greatest(width, length(next_number::text)), '0');
END $$;

CREATE OR REPLACE FUNCTION template_snapshot_from_draft(source_id uuid, expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  source public.template_versions; snapshot_id uuid; template_id uuid; relation text; column_names text;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT (
    public.app_has_permission('templates.manage') OR public.app_has_permission('test_requests.allocate')
    OR public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
    OR coalesce((SELECT v.template_id FROM public.template_versions v WHERE v.organization_id=org AND v.id=source_id)=public.laboratory_auto_job_template(),false)
  ) THEN RAISE EXCEPTION 'Runtime snapshot permission required' USING ERRCODE = '42501'; END IF;
  SELECT v.template_id INTO template_id FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id;
  PERFORM 1 FROM public.templates t WHERE t.organization_id = org AND t.id = template_id AND t.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template is unavailable' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO source FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id FOR UPDATE;
  IF source.status <> 'draft' OR source.revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'Template revision changed' USING ERRCODE = '40001';
  END IF;
  SELECT v.id INTO snapshot_id FROM public.template_versions v WHERE v.organization_id = org
    AND v.snapshot_source_id = source.id AND v.snapshot_source_revision = source.revision AND v.status = 'frozen';
  IF snapshot_id IS NOT NULL THEN RETURN snapshot_id; END IF;
  INSERT INTO public.template_versions (organization_id, template_id, number, status, name, description, kind,
    template_type, semantics, created_by, snapshot_source_id, snapshot_source_revision)
    SELECT org, source.template_id, coalesce(max(v.number), 0) + 1, 'building', source.name, source.description, source.kind,
      source.template_type, source.semantics, actor, source.id, source.revision
    FROM public.template_versions v WHERE v.organization_id = org AND v.template_id = source.template_id RETURNING id INTO snapshot_id;
  -- Only these definition tables are copied. Column identifiers come from PostgreSQL's
  -- catalog, never request data; new typed scalar columns are copied with their version.
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_repeat_groups',
    'template_fields', 'template_numeric_config', 'template_options', 'template_expressions', 'template_expression_nodes'] LOOP
    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO column_names FROM pg_attribute
      WHERE attrelid = format('public.%I', relation)::regclass AND attnum > 0 AND NOT attisdropped
        AND attname NOT IN ('organization_id', 'version_id') AND attgenerated = '';
    EXECUTE format('INSERT INTO public.%I (organization_id, version_id, %s)
      SELECT $1, $2, %s FROM public.%I WHERE organization_id = $1 AND version_id = $3', relation, column_names, column_names, relation)
      USING org, snapshot_id, source.id;
  END LOOP;
  UPDATE public.template_versions SET status = 'frozen', revision = revision + 1, frozen_at = now(), frozen_by = actor
    WHERE organization_id = org AND id = snapshot_id;
  RETURN snapshot_id;
END $$;
