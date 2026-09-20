-- Sample workflow transitions lock the sample FOR UPDATE. Runtime work takes
-- a compatible shared parent lock first, then its request/run/capture locks.
CREATE FUNCTION laboratory_lock_request_sample(p_request_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT public.laboratory_can_read() THEN RAISE EXCEPTION 'Laboratory permission required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.test_requests request
    JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    JOIN public.samples sample ON sample.organization_id=product.organization_id AND sample.id=product.sample_id
    WHERE request.organization_id=org AND request.id=p_request_id FOR KEY SHARE OF sample;
END $$;
GRANT EXECUTE ON FUNCTION laboratory_lock_request_sample(uuid) TO sampleify_app;

CREATE FUNCTION laboratory_request_can_work(p_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.app_has_permission('datasheets.execute') AND EXISTS (
    SELECT 1 FROM public.test_requests request
    JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
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
GRANT EXECUTE ON FUNCTION laboratory_request_can_work(uuid) TO sampleify_app;

CREATE OR REPLACE FUNCTION laboratory_capture_can_write() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  capture_id uuid:=nullif(current_setting('app.capture_id',true),'')::uuid;
  capture public.template_instances; sheet public.datasheets;
BEGIN
  IF org IS NULL OR actor IS NULL OR capture_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id=org AND id=capture_id;
  IF capture.id IS NULL OR capture.status<>'editing' THEN RETURN false; END IF;
  SELECT * INTO sheet FROM public.datasheets WHERE organization_id=org AND template_instance_id=capture_id;
  IF sheet.id IS NOT NULL THEN
    RETURN sheet.status IN ('in_progress','rejected') AND public.laboratory_request_can_work(sheet.test_request_id);
  END IF;
  RETURN capture.created_by=actor AND (public.app_has_permission('datasheets.execute')
    OR (capture.revision=1 AND (public.app_has_permission('test_requests.allocate') OR public.app_has_permission('samples.manage'))));
END $$;

CREATE OR REPLACE FUNCTION laboratory_lock_datasheet(sheet_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; request_id uuid; capture_id uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('datasheets.execute') THEN RAISE EXCEPTION 'Datasheet execution permission required' USING ERRCODE='42501'; END IF;
  SELECT test_request_id INTO request_id FROM public.datasheets WHERE organization_id=org AND id=sheet_id;
  IF request_id IS NULL THEN RETURN false; END IF;
  PERFORM public.laboratory_lock_request_sample(request_id);
  PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=request_id FOR UPDATE;
  SELECT template_instance_id INTO capture_id FROM public.datasheets WHERE organization_id=org AND id=sheet_id FOR UPDATE;
  PERFORM 1 FROM public.template_instances WHERE organization_id=org AND id=capture_id FOR UPDATE;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION workflow_lock_run(selected_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; run public.workflow_runs;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute') OR public.app_has_permission('approvals.respond')) THEN
    RAISE EXCEPTION 'Workflow action permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  IF run.id IS NULL THEN RETURN false; END IF;
  IF run.sample_id IS NOT NULL THEN
    PERFORM 1 FROM public.samples WHERE organization_id=org AND id=run.sample_id FOR UPDATE;
  ELSE
    PERFORM public.laboratory_lock_request_sample(run.test_request_id);
    PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=run.test_request_id FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.workflow_runs WHERE organization_id=org AND id=selected_run FOR UPDATE;
  RETURN true;
END $$;

-- This function uses the invoking role's INSERT policies. A typed row copy
-- retains every frozen request fact and replaces only method provenance.
CREATE FUNCTION laboratory_snapshot_method(p_request_id uuid,p_method_id uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  request public.test_requests; snapshot public.analytical_specifications; method public.methods_of_analysis; basis_id uuid;
BEGIN
  PERFORM public.laboratory_lock_request_sample(p_request_id);
  SELECT * INTO request FROM public.test_requests WHERE organization_id=org AND id=p_request_id FOR UPDATE;
  IF request.id IS NULL OR request.parent_test_request_id IS NOT NULL OR NOT public.laboratory_request_can_work(p_request_id) THEN
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
GRANT EXECUTE ON FUNCTION laboratory_snapshot_method(uuid,uuid) TO sampleify_app;

CREATE FUNCTION laboratory_guard_method_datasheet() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.test_requests; basis public.analytical_specifications; supplied public.analytical_specifications;
  method public.methods_of_analysis; expected public.analytical_specifications;
BEGIN
  SELECT * INTO request FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.test_request_id FOR UPDATE;
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
  IF request.parent_test_request_id IS NOT NULL OR NOT public.laboratory_request_can_work(request.id) OR supplied.basis_specification_id IS DISTINCT FROM request.specification_id THEN
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
CREATE TRIGGER laboratory_method_datasheet_guard BEFORE INSERT OR UPDATE ON datasheets FOR EACH ROW EXECUTE FUNCTION laboratory_guard_method_datasheet();

-- Events originate from the actual mutation. Applications cannot append a
-- plausible-looking method event without its corresponding datasheet change.
CREATE FUNCTION laboratory_record_method_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_type text; selected_sample uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=NEW.specification_id AND basis_specification_id IS NOT NULL) THEN RETURN NEW; END IF;
    event_type:='datasheet_method_added';
  ELSE
    IF NEW.status<>'void' OR OLD.status='void' OR EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.test_request_id AND status='cancelled') THEN RETURN NEW; END IF;
    event_type:='datasheet_method_voided';
  END IF;
  SELECT product.sample_id INTO selected_sample FROM public.test_requests request
    JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    WHERE request.organization_id=NEW.organization_id AND request.id=NEW.test_request_id;
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,datasheet_id,event_type,actor_user_id,description)
    VALUES(NEW.organization_id,selected_sample,NEW.test_request_id,NEW.id,event_type,nullif(current_setting('app.user_id',true),'')::uuid,
      CASE WHEN event_type='datasheet_method_added' THEN 'Added method to test request.' ELSE 'Deleted method from test request; datasheet history retained.' END);
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_method_event AFTER INSERT OR UPDATE ON datasheets FOR EACH ROW EXECUTE FUNCTION laboratory_record_method_event();

CREATE FUNCTION laboratory_guard_method_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.event_type IN ('datasheet_method_added','datasheet_method_voided') AND
    (pg_trigger_depth()<2 OR NEW.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.occurred_at IS DISTINCT FROM transaction_timestamp()) THEN
    RAISE EXCEPTION 'Method events must originate from the actual method change' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_method_event_guard BEFORE INSERT ON sample_events FOR EACH ROW EXECUTE FUNCTION laboratory_guard_method_event();
