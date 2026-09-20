CREATE FUNCTION workflow_test_request_submission(request_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT submission.id FROM public.test_requests request JOIN public.datasheets sheet
    ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id AND sheet.id=request.final_datasheet_id
    JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.datasheet_id=sheet.id AND submission.id=sheet.latest_submission_id
    JOIN public.template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    WHERE request.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND request.id=request_id AND public.laboratory_can_read()
      AND request.status IN ('under_review','approved') AND sheet.status IN ('under_review','approved') AND capture.status='frozen' AND capture.revision=submission.capture_revision
      AND EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=request.organization_id AND test_request_id=request.id AND assignment_type='analyst' AND unassigned_at IS NULL)
$$;
REVOKE ALL ON FUNCTION workflow_test_request_submission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_test_request_submission(uuid) TO sampleify_app;

CREATE FUNCTION workflow_guard_result_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE run public.workflow_runs;
BEGIN
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=NEW.organization_id AND id=NEW.workflow_run_id;
  IF NEW.datasheet_submission_id IS NOT NULL AND (run.test_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.datasheet_submissions submission JOIN public.datasheets sheet
    ON sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id WHERE submission.organization_id=NEW.organization_id
      AND submission.id=NEW.datasheet_submission_id AND sheet.test_request_id=run.test_request_id)) THEN
    RAISE EXCEPTION 'Workflow result evidence must belong to its test request' USING ERRCODE='23514';
  END IF;
  IF session_user='sampleify_app' AND run.test_request_id IS NOT NULL AND NEW.action IN ('requested','transitioned','approved','completed','cancelled')
    AND (NEW.datasheet_submission_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.test_requests request JOIN public.datasheets sheet
      ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id AND sheet.test_request_id=request.id
      JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.id=sheet.latest_submission_id
      JOIN public.template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
      WHERE request.organization_id=NEW.organization_id AND request.id=run.test_request_id AND submission.id=NEW.datasheet_submission_id
        AND capture.status='frozen' AND capture.revision=submission.capture_revision)) THEN
    RAISE EXCEPTION 'A transition must retain its actual frozen submitted result' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_result_history_guard BEFORE INSERT ON workflow_run_history FOR EACH ROW EXECUTE FUNCTION workflow_guard_result_history();

CREATE FUNCTION workflow_guard_result_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request_id uuid; result_id uuid;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  SELECT run.test_request_id, history.datasheet_submission_id INTO request_id,result_id FROM public.workflow_runs run JOIN public.workflow_run_history history
    ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.id=NEW.request_history_id
    WHERE run.organization_id=NEW.organization_id AND run.id=NEW.workflow_run_id;
  IF request_id IS NOT NULL THEN
    PERFORM 1 FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=request_id FOR UPDATE;
    IF result_id IS NULL OR result_id IS DISTINCT FROM public.workflow_test_request_submission(request_id) THEN
      RAISE EXCEPTION 'Approval request must identify the submitted test request result' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_result_request_guard BEFORE INSERT ON approval_cases FOR EACH ROW EXECUTE FUNCTION workflow_guard_result_request();

CREATE FUNCTION workflow_apply_test_request_transition(selected_run uuid, selected_transition uuid, expected_revision integer, remarks text)
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
    UPDATE public.sample_tests selected SET status='completed',updated_at=now() FROM public.test_requests request
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
REVOKE ALL ON FUNCTION workflow_apply_test_request_transition(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_apply_test_request_transition(uuid,uuid,integer,text) TO sampleify_app;

CREATE OR REPLACE FUNCTION laboratory_submission_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests request
    ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id JOIN public.template_instances capture
    ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    WHERE sheet.organization_id=NEW.organization_id AND sheet.id=NEW.datasheet_id AND sheet.latest_submission_id=NEW.id
      AND ((sheet.status IN ('under_review','approved') AND request.status IN ('under_review','approved'))
        OR (sheet.status='void' AND request.status='cancelled' AND EXISTS (SELECT 1 FROM public.workflow_run_history history JOIN public.workflow_runs run
          ON run.organization_id=history.organization_id AND run.id=history.workflow_run_id WHERE run.organization_id=NEW.organization_id AND run.test_request_id=request.id
            AND history.datasheet_submission_id=NEW.id AND history.action='cancelled' AND history.xmin::text=pg_current_xact_id()::text)))
      AND sheet.completed_by=NEW.submitted_by AND sheet.completed_at=NEW.submitted_at AND request.final_datasheet_id=sheet.id AND capture.status='frozen' AND capture.revision=NEW.capture_revision
      AND EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=sheet.organization_id AND event.test_request_id=request.id
        AND event.event_type='datasheet_submitted' AND event.actor_user_id=NEW.submitted_by AND event.xmin::text=pg_current_xact_id()::text)) THEN
    RAISE EXCEPTION 'Submission, frozen capture, owner status and actual audit event must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
