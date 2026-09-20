-- Preserve the later same-transaction cancellation evidence branch from 0038
-- while checking the actual source capture introduced for grouped submissions.
CREATE OR REPLACE FUNCTION laboratory_submission_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests request
    ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id JOIN public.template_instances capture
    ON capture.organization_id=sheet.organization_id AND capture.id=NEW.instance_id
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
