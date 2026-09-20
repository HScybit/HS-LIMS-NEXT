ALTER TABLE "sample_events" DROP CONSTRAINT "sample_event_type";--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_event_type" CHECK ("sample_events"."event_type" in ('sample_registered', 'test_requests_generated', 'test_request_assigned', 'datasheet_created', 'datasheet_submitted', 'reports_generated', 'reports_finalized', 'datasheet_method_added', 'datasheet_method_voided', 'test_request_job_created', 'sample_updated'));
--> statement-breakpoint
-- Other laboratory operators can append their own allocation/result events;
-- the new header-edit event requires sample management authority.
CREATE FUNCTION laboratory_guard_sample_edit_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.event_type='sample_updated' THEN
    IF session_user='sampleify_app' AND NOT public.app_has_permission('samples.manage') THEN
      RAISE EXCEPTION 'Sample management permission required' USING ERRCODE='42501';
    END IF;
    IF NEW.test_request_id IS NOT NULL OR NEW.datasheet_id IS NOT NULL THEN
      RAISE EXCEPTION 'A sample header edit event belongs to the sample' USING ERRCODE='23514',CONSTRAINT='sample_edit_event_owner';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_sample_edit_event BEFORE INSERT ON sample_events
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_edit_event();
REVOKE ALL ON FUNCTION laboratory_guard_sample_edit_event() FROM PUBLIC,sampleify_app,sampleify_report_worker;
