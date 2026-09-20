-- Approval responders may lock/reserve an authorized workflow without acquiring
-- unrestricted UPDATE access to its sample or test request.
CREATE FUNCTION workflow_can_request(selected_transition uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute') OR public.app_has_permission('approvals.respond'))
    AND EXISTS (SELECT 1 FROM public.workflow_transitions transition
      WHERE transition.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND transition.id=selected_transition
      AND (NOT EXISTS (SELECT 1 FROM public.workflow_transition_creator_roles creator WHERE creator.organization_id=transition.organization_id AND creator.transition_id=transition.id)
        OR EXISTS (SELECT 1 FROM public.workflow_transition_creator_roles creator JOIN public.membership_roles membership
          ON membership.organization_id=creator.organization_id AND membership.role_id=creator.role_id
          WHERE creator.organization_id=transition.organization_id AND creator.transition_id=transition.id
            AND membership.user_id=nullif(current_setting('app.user_id',true),'')::uuid)))
$$;
REVOKE ALL ON FUNCTION workflow_can_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_can_request(uuid) TO sampleify_app;

CREATE FUNCTION workflow_lock_run(selected_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; run public.workflow_runs;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute') OR public.app_has_permission('approvals.respond')) THEN
    RAISE EXCEPTION 'Workflow action permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  IF run.id IS NULL THEN RETURN false; END IF;
  -- Owner first, then run. Capture/allocation already lock the test request;
  -- approval decisions use this same order before locking their case/stage.
  IF run.sample_id IS NOT NULL THEN PERFORM 1 FROM public.samples WHERE organization_id=org AND id=run.sample_id FOR UPDATE;
  ELSE PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=run.test_request_id FOR UPDATE; END IF;
  PERFORM 1 FROM public.workflow_runs WHERE organization_id=org AND id=selected_run FOR UPDATE;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION workflow_lock_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_lock_run(uuid) TO sampleify_app;

CREATE FUNCTION workflow_reserve_request(selected_run uuid, selected_transition uuid, expected_revision integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; next_revision integer;
BEGIN
  IF NOT public.workflow_lock_run(selected_run) OR NOT public.workflow_can_request(selected_transition) THEN
    RAISE EXCEPTION 'Workflow transition permission required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_cases WHERE organization_id=org AND workflow_run_id=selected_run AND status='pending') THEN
    RAISE EXCEPTION 'A workflow approval is already pending' USING ERRCODE='23514';
  END IF;
  UPDATE public.workflow_runs run SET revision=revision+1 WHERE run.organization_id=org AND run.id=selected_run
    AND run.status='active' AND run.revision=expected_revision AND EXISTS (SELECT 1 FROM public.workflow_transitions transition
      WHERE transition.organization_id=org AND transition.id=selected_transition AND transition.workflow_version_id=run.workflow_version_id
        AND transition.source_state_id=run.current_state_id AND transition.approval_mode<>'none') RETURNING revision INTO next_revision;
  RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION workflow_reserve_request(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_reserve_request(uuid,uuid,integer) TO sampleify_app;

CREATE FUNCTION workflow_apply_sample_transition(selected_run uuid, selected_transition uuid, expected_revision integer, remarks text)
RETURNS TABLE(revision integer, status text, history_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  run public.workflow_runs; transition public.workflow_transitions; target public.workflow_states; approved boolean; next_status text;
  total_count bigint; allocated_count bigint; approved_count bigint; recorded_history uuid;
BEGIN
  IF NOT public.workflow_lock_run(selected_run) OR actor IS NULL OR length(remarks)>5000 THEN
    RAISE EXCEPTION 'Invalid workflow transition request' USING ERRCODE='42501';
  END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  SELECT * INTO transition FROM public.workflow_transitions WHERE organization_id=org AND id=selected_transition
    AND workflow_version_id=run.workflow_version_id AND source_state_id=run.current_state_id;
  IF run.status<>'active' OR run.revision<>expected_revision OR run.sample_id IS NULL OR transition.id IS NULL
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
  IF target.require_all_test_requests_allocated OR target.require_all_test_requests_approved THEN
    PERFORM request.id FROM public.test_requests request JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
      JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
      WHERE request.organization_id=org AND product.sample_id=run.sample_id ORDER BY request.id FOR SHARE OF request;
    SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.test_request_assignments assignment
        WHERE assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL)),
      count(*) FILTER (WHERE request.status='approved') INTO total_count,allocated_count,approved_count
      FROM public.test_requests request JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
      JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
      WHERE request.organization_id=org AND product.sample_id=run.sample_id AND request.status<>'cancelled';
    IF total_count=0 OR (target.require_all_test_requests_allocated AND allocated_count<>total_count) OR (target.require_all_test_requests_approved AND approved_count<>total_count) THEN
      RAISE EXCEPTION 'Required test requests are not allocated or approved' USING ERRCODE='23514';
    END IF;
  END IF;
  next_status:=CASE WHEN target.state_type='cancelled' THEN 'cancelled' WHEN target.state_type='final' THEN 'completed' ELSE 'active' END;
  UPDATE public.workflow_runs stored SET current_state_id=target.id, status=next_status, revision=stored.revision+1,
    completed_at=CASE WHEN next_status<>'active' THEN transaction_timestamp() ELSE NULL END WHERE stored.organization_id=org AND stored.id=run.id;
  IF next_status<>'active' THEN UPDATE public.samples SET status=next_status, revision=samples.revision+1, updated_at=now() WHERE organization_id=org AND id=run.sample_id; END IF;
  INSERT INTO public.workflow_run_history(organization_id,workflow_run_id,workflow_version_id,from_state_id,to_state_id,transition_id,action,actor_user_id,comment)
    VALUES(org,run.id,run.workflow_version_id,run.current_state_id,target.id,transition.id,
      CASE WHEN next_status='completed' THEN 'completed' WHEN next_status='cancelled' THEN 'cancelled' WHEN approved THEN 'approved' ELSE 'transitioned' END,actor,remarks) RETURNING id INTO recorded_history;
  RETURN QUERY SELECT expected_revision+1,next_status,recorded_history;
END $$;
REVOKE ALL ON FUNCTION workflow_apply_sample_transition(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_apply_sample_transition(uuid,uuid,integer,text) TO sampleify_app;
