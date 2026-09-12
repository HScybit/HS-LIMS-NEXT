-- The target selected-test record has no mutable timestamp column. Its actual
-- completion time and actor are retained by the linked workflow history.
CREATE OR REPLACE FUNCTION workflow_apply_test_request_transition(selected_run uuid, selected_transition uuid, expected_revision integer, remarks text)
RETURNS TABLE(revision integer,status text,history_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  run public.workflow_runs; transition public.workflow_transitions; target public.workflow_states;
  approved boolean; next_status text; recorded_history uuid; result_id uuid;
BEGIN
  IF NOT public.workflow_lock_run(selected_run) OR actor IS NULL OR length(remarks)>5000 THEN RAISE EXCEPTION 'Invalid workflow transition request' USING ERRCODE='42501'; END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  SELECT * INTO transition FROM public.workflow_transitions WHERE organization_id=org AND id=selected_transition
    AND workflow_version_id=run.workflow_version_id AND source_state_id=run.current_state_id;
  IF run.status<>'active' OR run.revision<>expected_revision OR run.test_request_id IS NULL OR transition.id IS NULL
    OR EXISTS (SELECT 1 FROM public.approval_cases pending WHERE pending.organization_id=org AND pending.workflow_run_id=run.id AND pending.status='pending') THEN
    RAISE EXCEPTION 'Workflow changed or an approval is pending' USING ERRCODE='23514';
  END IF;
  result_id:=public.workflow_test_request_submission(run.test_request_id);
  IF result_id IS NULL THEN RAISE EXCEPTION 'A frozen submitted result and analyst allocation are required' USING ERRCODE='23514'; END IF;
  SELECT EXISTS (SELECT 1 FROM public.approval_cases approval JOIN public.workflow_run_history request_history ON request_history.organization_id=approval.organization_id AND request_history.id=approval.request_history_id
    JOIN public.approval_stages stage ON stage.organization_id=approval.organization_id AND stage.approval_case_id=approval.id
    JOIN public.approval_assignments assignment ON assignment.organization_id=stage.organization_id AND assignment.approval_stage_id=stage.id
    JOIN public.approval_decisions decision ON decision.organization_id=assignment.organization_id AND decision.approval_assignment_id=assignment.id
    WHERE approval.organization_id=org AND approval.workflow_run_id=run.id AND approval.transition_id=transition.id AND approval.run_revision=expected_revision
      AND approval.status='approved' AND approval.resolved_at=transaction_timestamp() AND decision.decided_by=actor AND decision.decided_at=transaction_timestamp()
      AND request_history.datasheet_submission_id=result_id) INTO approved;
  IF NOT ((transition.approval_mode='none' AND public.workflow_can_request(transition.id)) OR (approved AND public.app_has_permission('approvals.respond'))) THEN
    RAISE EXCEPTION 'This transition requires its configured approval for this result' USING ERRCODE='42501';
  END IF;
  IF transition.require_comment AND nullif(trim(remarks),'') IS NULL THEN RAISE EXCEPTION 'A transition comment is required' USING ERRCODE='23514'; END IF;
  SELECT * INTO target FROM public.workflow_states WHERE organization_id=org AND id=transition.target_state_id;
  next_status:=CASE WHEN target.state_type='cancelled' THEN 'cancelled' WHEN target.state_type='final' THEN 'completed' ELSE 'active' END;
  UPDATE public.workflow_runs stored SET current_state_id=target.id,status=next_status,revision=stored.revision+1,
    completed_at=CASE WHEN next_status<>'active' THEN transaction_timestamp() ELSE NULL END WHERE stored.organization_id=org AND stored.id=run.id;
  IF next_status='completed' THEN
    UPDATE public.test_requests request SET status='approved',completed_at=now(),revision=request.revision+1 WHERE request.organization_id=org AND request.id=run.test_request_id;
    -- Only the selected, submitted datasheet was approved by this transition.
    -- An unsubmitted alternative must never acquire invented approval evidence.
    UPDATE public.datasheets sheet SET status='approved',revision=sheet.revision+1 FROM public.test_requests request
      WHERE request.organization_id=org AND request.id=run.test_request_id AND sheet.organization_id=org AND sheet.id=request.final_datasheet_id;
    UPDATE public.sample_tests selected SET status='completed' FROM public.test_requests request
      WHERE request.organization_id=org AND request.id=run.test_request_id AND selected.organization_id=org AND selected.id=request.sample_test_id;
  ELSIF next_status='cancelled' THEN
    UPDATE public.test_requests request SET status='cancelled',revision=request.revision+1 WHERE request.organization_id=org AND request.id=run.test_request_id;
    UPDATE public.datasheets sheet SET status='void',revision=sheet.revision+1 WHERE sheet.organization_id=org AND sheet.test_request_id=run.test_request_id AND sheet.status<>'void';
  END IF;
  INSERT INTO public.workflow_run_history(organization_id,workflow_run_id,workflow_version_id,from_state_id,to_state_id,transition_id,datasheet_submission_id,action,actor_user_id,comment)
    VALUES(org,run.id,run.workflow_version_id,run.current_state_id,target.id,transition.id,result_id,
      CASE WHEN next_status='completed' THEN 'completed' WHEN next_status='cancelled' THEN 'cancelled' WHEN approved THEN 'approved' ELSE 'transitioned' END,actor,remarks) RETURNING id INTO recorded_history;
  RETURN QUERY SELECT expected_revision+1,next_status,recorded_history;
END $$;
