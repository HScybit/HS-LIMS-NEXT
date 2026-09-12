CREATE FUNCTION report_pdf_job_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PDF job history cannot be deleted' USING ERRCODE='55000'; END IF;
  IF OLD.status IN ('succeeded','failed') OR
    (NEW.organization_id,NEW.id,NEW.report_id,NEW.renderer_id,NEW.requested_by,NEW.requested_at) IS DISTINCT FROM
    (OLD.organization_id,OLD.id,OLD.report_id,OLD.renderer_id,OLD.requested_by,OLD.requested_at) THEN
    RAISE EXCEPTION 'PDF job identity and completed history are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_pdf_job_guard BEFORE UPDATE OR DELETE ON report_pdf_jobs FOR EACH ROW EXECUTE FUNCTION report_pdf_job_guard();

CREATE FUNCTION report_pdf_attempt_sequence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs; attempt public.report_pdf_attempts; target_job_id uuid; attempt_count integer;
BEGIN
  IF TG_TABLE_NAME='report_pdf_jobs' THEN target_job_id:=NEW.id; ELSE target_job_id:=NEW.job_id; END IF;
  SELECT * INTO job FROM public.report_pdf_jobs j WHERE j.organization_id=NEW.organization_id AND j.id=target_job_id;
  SELECT count(*) INTO attempt_count FROM public.report_pdf_attempts a WHERE a.organization_id=job.organization_id AND a.job_id=job.id;
  IF job.attempts<>attempt_count OR EXISTS (SELECT 1 FROM public.report_pdf_attempts a
    WHERE a.organization_id=job.organization_id AND a.job_id=job.id AND (a.attempt_number>job.attempts OR (a.attempt_number<job.attempts AND a.status NOT IN ('failed','expired')))) THEN
    RAISE EXCEPTION 'PDF job attempts must be consecutive and preserve prior failures' USING ERRCODE='23514';
  END IF;
  IF job.attempts=0 THEN
    IF job.status<>'queued' OR job.started_at IS NOT NULL THEN RAISE EXCEPTION 'An unstarted PDF job must be queued' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO attempt FROM public.report_pdf_attempts a WHERE a.organization_id=job.organization_id AND a.job_id=job.id AND a.attempt_number=job.attempts;
    IF job.started_at IS DISTINCT FROM attempt.started_at OR
      (job.status='queued' AND attempt.status<>'failed') OR (job.status='running' AND attempt.status<>'running') OR
      (job.status='succeeded' AND attempt.status<>'succeeded') OR (job.status='failed' AND attempt.status NOT IN ('failed','expired')) THEN
      RAISE EXCEPTION 'PDF job state must match its current attempt' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_pdf_job_attempt_sequence AFTER INSERT OR UPDATE ON report_pdf_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_pdf_attempt_sequence_guard();
CREATE CONSTRAINT TRIGGER report_pdf_attempt_sequence AFTER INSERT OR UPDATE ON report_pdf_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_pdf_attempt_sequence_guard();
REVOKE ALL ON FUNCTION report_pdf_job_guard(),report_pdf_attempt_sequence_guard() FROM PUBLIC;
