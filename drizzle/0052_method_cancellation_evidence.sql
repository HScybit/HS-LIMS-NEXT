-- Check after the whole transaction: the workflow writes its cancellation
-- history after retiring the datasheets. A status string alone is not evidence.
CREATE FUNCTION laboratory_require_method_retirement_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (
    SELECT 1 FROM public.sample_events event WHERE event.organization_id=NEW.organization_id
      AND event.test_request_id=NEW.test_request_id AND event.datasheet_id=NEW.id AND event.event_type='datasheet_method_voided'
      AND event.actor_user_id=actor AND event.occurred_at=transaction_timestamp()
  ) AND NOT EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history
      ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.to_state_id=run.current_state_id
    JOIN public.test_requests request ON request.organization_id=run.organization_id AND request.id=run.test_request_id
    WHERE run.organization_id=NEW.organization_id AND run.test_request_id=NEW.test_request_id AND run.status='cancelled' AND request.status='cancelled'
      AND history.action='cancelled' AND history.actor_user_id=actor AND history.occurred_at=transaction_timestamp()
  ) THEN RAISE EXCEPTION 'Method retirement requires its actual change or workflow cancellation evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER laboratory_method_retirement_evidence AFTER UPDATE ON datasheets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status='void' AND OLD.status<>'void')
  EXECUTE FUNCTION laboratory_require_method_retirement_evidence();
