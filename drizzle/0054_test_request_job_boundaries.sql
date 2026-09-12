-- A job owns a product line; an individual request owns a selected test on
-- that line. This read projection keeps both paths under the base row policies.
CREATE VIEW laboratory_test_request_context WITH (security_invoker=true) AS
SELECT request.organization_id,request.id AS test_request_id,product.id AS sample_product_id,
  product.sample_id,product.sample_category_id,product.product_id,product.product_name
FROM public.test_requests request LEFT JOIN public.sample_tests selected
  ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
JOIN public.sample_products product ON product.organization_id=request.organization_id
  AND product.id=coalesce(request.job_sample_product_id,selected.sample_product_id);
GRANT SELECT ON laboratory_test_request_context TO sampleify_app,sampleify_report_worker;

ALTER TABLE organization_laboratory_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY laboratory_settings_read ON organization_laboratory_settings FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (public.laboratory_can_read() OR public.app_has_permission('settings.read') OR public.app_has_permission('settings.manage')));
CREATE POLICY laboratory_settings_insert ON organization_laboratory_settings FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND public.app_has_permission('settings.manage'));
CREATE POLICY laboratory_settings_update ON organization_laboratory_settings FOR UPDATE TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND public.app_has_permission('settings.manage'))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND public.app_has_permission('settings.manage'));
GRANT SELECT,INSERT,UPDATE ON organization_laboratory_settings TO sampleify_app;
INSERT INTO permissions(code,description) VALUES('settings.read','View organization settings'),('settings.manage','Manage organization settings') ON CONFLICT DO NOTHING;

CREATE FUNCTION laboratory_guard_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_laboratory_settings FOR EACH ROW EXECUTE FUNCTION laboratory_guard_settings();

CREATE FUNCTION laboratory_settings_options() RETURNS TABLE(id uuid,kind text,label text)
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
      AND EXISTS (SELECT 1 FROM public.workflow_versions version WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published');
END $$;
GRANT EXECUTE ON FUNCTION laboratory_settings_options() TO sampleify_app;

CREATE FUNCTION laboratory_job_settings() RETURNS TABLE(auto_create_jobs boolean,result_summary_template_id uuid,job_workflow_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('test_requests.allocate') THEN
    RAISE EXCEPTION 'Job allocation permission required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.auto_create_jobs,settings.result_summary_template_id,settings.job_workflow_id
    FROM public.organization_laboratory_settings settings WHERE settings.organization_id=org FOR SHARE;
END $$;
GRANT EXECUTE ON FUNCTION laboratory_job_settings() TO sampleify_app;

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
      IF OLD.parent_test_request_id IS NOT NULL OR NEW.parent_test_request_id IS NULL OR OLD.status<>'created' OR NEW.is_job
        OR NOT public.app_has_permission('test_requests.allocate')
        OR NEW.job_linked_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.job_linked_at IS DISTINCT FROM transaction_timestamp()
        OR EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND assignment_type='analyst' AND unassigned_at IS NULL)
      THEN RAISE EXCEPTION 'Only an unallocated request can join a new job' USING ERRCODE='42501'; END IF;
      SELECT * INTO job FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.parent_test_request_id FOR UPDATE;
      IF NOT coalesce(job.is_job,false) OR job.created_at IS DISTINCT FROM transaction_timestamp() OR job.created_by IS DISTINCT FROM NEW.job_linked_by
        OR NOT EXISTS (SELECT 1 FROM public.sample_tests WHERE organization_id=NEW.organization_id AND id=NEW.sample_test_id AND sample_product_id=job.job_sample_product_id)
      THEN RAISE EXCEPTION 'Job members must belong to the same product line and creation action' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.datasheet_template_id IS DISTINCT FROM OLD.datasheet_template_id AND
      (OLD.datasheet_template_id IS NOT NULL OR NEW.datasheet_template_id IS NULL OR NOT public.app_has_permission('test_requests.allocate')
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
      IF NOT public.app_has_permission('test_requests.allocate') OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
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

CREATE FUNCTION laboratory_complete_job_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_count integer; last_position integer; first_position integer; selected_sample uuid;
BEGIN
  SELECT count(*)::integer,min(job_member_position),max(job_member_position) INTO member_count,first_position,last_position
    FROM public.test_requests WHERE organization_id=NEW.organization_id AND parent_test_request_id=NEW.id;
  IF member_count=0 OR first_position<>0 OR last_position<>member_count-1 THEN
    RAISE EXCEPTION 'A job requires an ordered set of linked requests' USING ERRCODE='23514';
  END IF;
  SELECT sample_id INTO selected_sample FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.job_sample_product_id;
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    VALUES(NEW.organization_id,selected_sample,NEW.id,'test_request_job_created',NEW.created_by,
      format('Created job with %s test request%s.',member_count,CASE WHEN member_count=1 THEN '' ELSE 's' END));
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER laboratory_job_creation AFTER INSERT ON test_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.is_job) EXECUTE FUNCTION laboratory_complete_job_creation();

CREATE FUNCTION laboratory_guard_job_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.event_type='test_request_job_created' AND (pg_trigger_depth()<2
    OR NEW.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.occurred_at IS DISTINCT FROM transaction_timestamp())
  THEN RAISE EXCEPTION 'Job events require the actual creation action' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_job_event_guard BEFORE INSERT ON sample_events FOR EACH ROW EXECUTE FUNCTION laboratory_guard_job_event();


-- Extend the existing request boundaries to product-line jobs.
CREATE OR REPLACE FUNCTION laboratory_lock_request_sample(p_request_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT public.laboratory_can_read() THEN RAISE EXCEPTION 'Laboratory permission required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.test_requests request
    JOIN public.laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    JOIN public.samples sample ON sample.organization_id=product.organization_id AND sample.id=product.sample_id
    WHERE request.organization_id=org AND request.id=p_request_id FOR KEY SHARE OF sample;
END $$;

CREATE OR REPLACE FUNCTION laboratory_request_can_work(p_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.app_has_permission('datasheets.execute') AND EXISTS (
    SELECT 1 FROM public.test_requests request
    JOIN public.laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    WHERE request.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
      AND request.id=p_request_id AND request.status IN ('allocated','in_progress','rejected')
      AND EXISTS (SELECT 1 FROM public.test_request_assignments assignment JOIN public.memberships member
        ON member.organization_id=assignment.organization_id AND member.user_id=assignment.assigned_user_id
        JOIN public.users actor ON actor.id=member.user_id
        WHERE assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id
          AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
          AND assignment.assigned_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND member.active AND actor.active)
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.approval_cases approval
        ON approval.organization_id=run.organization_id AND approval.workflow_run_id=run.id
        WHERE run.organization_id=request.organization_id AND run.test_request_id=request.id AND approval.status='pending')
      -- Match workflowAllowedActions: the flag applies when this sample state
      -- has configured capabilities; otherwise execution permission is fallback.
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_states state
        ON state.organization_id=run.organization_id AND state.id=run.current_state_id
        WHERE run.organization_id=request.organization_id AND run.sample_id=product.sample_id AND NOT state.can_work_on_test_request
          AND EXISTS (SELECT 1 FROM public.workflow_state_capability_roles capability
            WHERE capability.organization_id=state.organization_id AND capability.workflow_state_id=state.id))
  )
$$;

CREATE OR REPLACE FUNCTION laboratory_snapshot_method(p_request_id uuid,p_method_id uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  request public.test_requests; snapshot public.analytical_specifications; method public.methods_of_analysis; basis_id uuid;
BEGIN
  PERFORM public.laboratory_lock_request_sample(p_request_id);
  SELECT * INTO request FROM public.test_requests WHERE organization_id=org AND id=p_request_id FOR UPDATE;
  IF request.id IS NULL OR request.is_job OR NOT public.laboratory_request_can_work(p_request_id) THEN
    RAISE EXCEPTION 'Only the assigned analyst can change an open method' USING ERRCODE='42501';
  END IF;
  SELECT * INTO snapshot FROM public.analytical_specifications WHERE organization_id=org AND id=request.specification_id;
  PERFORM public.laboratory_lock_references('test_parameters',ARRAY[snapshot.test_parameter_id]);
  PERFORM public.laboratory_lock_references('parameter_methods',ARRAY[snapshot.test_parameter_id]);
  PERFORM public.laboratory_lock_references('methods_of_analysis',ARRAY[p_method_id]);
  SELECT * INTO method FROM public.methods_of_analysis WHERE organization_id=org AND id=p_method_id AND active;
  IF method.id IS NULL OR (EXISTS (SELECT 1 FROM public.parameter_methods WHERE organization_id=org AND test_parameter_id=snapshot.test_parameter_id)
    AND NOT EXISTS (SELECT 1 FROM public.parameter_methods WHERE organization_id=org AND test_parameter_id=snapshot.test_parameter_id AND method_id=method.id)) THEN
    RAISE EXCEPTION 'The method is not applicable to this parameter' USING ERRCODE='23514';
  END IF;
  IF snapshot.basis_specification_id IS NOT NULL THEN RAISE EXCEPTION 'A method snapshot requires the original request specification' USING ERRCODE='23514'; END IF;
  basis_id:=snapshot.id;
  snapshot.id:=gen_random_uuid(); snapshot.basis_specification_id:=basis_id;
  snapshot.method_id:=method.id; snapshot.method_revision:=method.revision; snapshot.method_code:=method.code; snapshot.method_name:=method.name;
  snapshot.method_description:=method.description; snapshot.method_uuid:=method.method_uuid; snapshot.decimal_scale:=method.decimal_scale; snapshot.parse_number:=method.parse_number;
  snapshot.recorded_by:=nullif(current_setting('app.user_id',true),'')::uuid; snapshot.recorded_at:=transaction_timestamp();
  INSERT INTO public.analytical_specifications SELECT (snapshot).*;
  INSERT INTO public.analytical_specification_limits(organization_id,specification_id,id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order)
    SELECT organization_id,snapshot.id,id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order
    FROM public.analytical_specification_limits WHERE organization_id=org AND specification_id=basis_id;
  RETURN snapshot.id;
END $$;

CREATE OR REPLACE FUNCTION laboratory_guard_method_datasheet() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.test_requests; basis public.analytical_specifications; supplied public.analytical_specifications;
  method public.methods_of_analysis; expected public.analytical_specifications;
BEGIN
  SELECT * INTO request FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.test_request_id FOR UPDATE;
  IF TG_OP='INSERT' AND request.is_job THEN
    IF NEW.specification_id IS NOT NULL OR NEW.method_id IS NOT NULL OR NEW.attempt_number<>1
      OR NOT public.app_has_permission('test_requests.allocate') OR request.status NOT IN ('created','allocated')
      OR EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=NEW.organization_id AND test_request_id=request.id)
      OR NOT EXISTS (SELECT 1 FROM public.template_instances capture JOIN public.template_versions version
        ON version.organization_id=capture.organization_id AND version.id=capture.version_id
        WHERE capture.organization_id=NEW.organization_id AND capture.id=NEW.template_instance_id
          AND capture.created_by=NEW.created_by AND capture.created_at=NEW.created_at AND capture.revision=1
          AND version.template_id=request.datasheet_template_id AND version.kind='datasheet' AND version.status='frozen')
    THEN RAISE EXCEPTION 'A job requires one new summary capture and has no individual method' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status='void' THEN RAISE EXCEPTION 'Retired methods are immutable' USING ERRCODE='55000'; END IF;
    -- Cancellation has already changed the request status in its authorized
    -- workflow command. It retires every method, including submitted ones.
    IF NEW.status='void' AND request.status<>'cancelled' THEN
      IF OLD.status NOT IN ('in_progress','rejected') OR NOT public.laboratory_request_can_work(request.id) THEN
        RAISE EXCEPTION 'Only the assigned analyst can retire an open method' USING ERRCODE='42501';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=NEW.organization_id AND test_request_id=request.id AND id<>NEW.id AND status<>'void') THEN
        RAISE EXCEPTION 'At least one method must remain' USING ERRCODE='23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.template_instances WHERE organization_id=NEW.organization_id AND id=NEW.template_instance_id AND status='frozen') THEN
        RAISE EXCEPTION 'A retired method must preserve a frozen capture' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO supplied FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=NEW.specification_id;
  IF supplied.id=request.specification_id AND NOT EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=NEW.organization_id AND test_request_id=request.id) THEN RETURN NEW; END IF;
  IF request.is_job OR NOT public.laboratory_request_can_work(request.id) OR supplied.basis_specification_id IS DISTINCT FROM request.specification_id THEN
    RAISE EXCEPTION 'An alternate datasheet must use its open request specification' USING ERRCODE='42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM transaction_timestamp() OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Method creation must record the actual actor and time' USING ERRCODE='42501';
  END IF;
  IF NEW.attempt_number<>(SELECT coalesce(max(attempt_number),0)+1 FROM public.datasheets WHERE organization_id=NEW.organization_id AND test_request_id=request.id)
    OR EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=NEW.organization_id AND test_request_id=request.id AND method_id=NEW.method_id AND status<>'void') THEN
    RAISE EXCEPTION 'The method already exists or its attempt number changed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO basis FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=request.specification_id;
  SELECT * INTO method FROM public.methods_of_analysis WHERE organization_id=NEW.organization_id AND id=NEW.method_id FOR SHARE;
  IF basis.basis_specification_id IS NOT NULL OR NOT method.active OR (EXISTS (SELECT 1 FROM public.parameter_methods WHERE organization_id=NEW.organization_id AND test_parameter_id=basis.test_parameter_id)
    AND NOT EXISTS (SELECT 1 FROM public.parameter_methods WHERE organization_id=NEW.organization_id AND test_parameter_id=basis.test_parameter_id AND method_id=NEW.method_id)) THEN
    RAISE EXCEPTION 'The method is not applicable to this parameter' USING ERRCODE='23514';
  END IF;
  expected:=basis; expected.id:=supplied.id; expected.basis_specification_id:=basis.id;
  expected.method_id:=method.id; expected.method_revision:=method.revision; expected.method_code:=method.code; expected.method_name:=method.name;
  expected.method_description:=method.description; expected.method_uuid:=method.method_uuid; expected.decimal_scale:=method.decimal_scale; expected.parse_number:=method.parse_number;
  expected.recorded_by:=NEW.created_by; expected.recorded_at:=NEW.created_at;
  IF supplied IS DISTINCT FROM expected OR EXISTS (
    (SELECT id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order FROM public.analytical_specification_limits WHERE organization_id=NEW.organization_id AND specification_id=basis.id
      EXCEPT SELECT id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order FROM public.analytical_specification_limits WHERE organization_id=NEW.organization_id AND specification_id=supplied.id)
    UNION ALL
    (SELECT id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order FROM public.analytical_specification_limits WHERE organization_id=NEW.organization_id AND specification_id=supplied.id
      EXCEPT SELECT id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order FROM public.analytical_specification_limits WHERE organization_id=NEW.organization_id AND specification_id=basis.id)
  ) THEN RAISE EXCEPTION 'An alternate method must retain the frozen request criterion' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
