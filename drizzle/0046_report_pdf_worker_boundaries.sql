-- The worker has no inherited application role and no domain write grants.
GRANT USAGE ON SCHEMA public TO sampleify_report_worker;

CREATE FUNCTION report_pdf_enqueue(p_report_id uuid, p_renderer_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  report public.sample_reports; result_id uuid;
BEGIN
  SELECT * INTO report FROM public.sample_reports WHERE organization_id=org AND id=p_report_id;
  IF NOT FOUND OR NOT (public.app_has_permission('samples.read') OR public.app_has_permission('samples.manage'))
    OR NOT public.report_can_print(report.sample_id) THEN RAISE EXCEPTION 'Report print permission required' USING ERRCODE='42501'; END IF;
  IF p_renderer_id IS NULL OR p_renderer_id !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid report renderer' USING ERRCODE='22023'; END IF;
  INSERT INTO public.report_pdf_jobs(organization_id,report_id,renderer_id,requested_by)
    VALUES(org,p_report_id,p_renderer_id,actor) ON CONFLICT ON CONSTRAINT report_pdf_job_report_key DO NOTHING RETURNING id INTO result_id;
  IF result_id IS NULL THEN SELECT id INTO result_id FROM public.report_pdf_jobs WHERE organization_id=org AND report_id=p_report_id; END IF;
  RETURN result_id;
END $$;

CREATE FUNCTION report_pdf_require_lease(p_org_id uuid,p_job_id uuid,p_token uuid) RETURNS public.report_pdf_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs;
BEGIN
  SELECT * INTO job FROM public.report_pdf_jobs WHERE organization_id=p_org_id AND id=p_job_id FOR UPDATE;
  IF NOT FOUND OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.lease_token_hash IS DISTINCT FROM sha256(convert_to(p_token::text,'UTF8')) THEN
    RAISE EXCEPTION 'Report job lease is unavailable' USING ERRCODE='40001';
  END IF;
  RETURN job;
END $$;

CREATE FUNCTION report_pdf_claim(p_renderer_id text,p_worker_id uuid)
RETURNS TABLE(organization_id uuid,job_id uuid,report_id uuid,renderer_id text,attempt_number integer,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs; at_time timestamptz; token uuid; scanned integer:=0;
BEGIN
  IF p_worker_id IS NULL OR p_renderer_id IS NULL OR p_renderer_id !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid worker identity' USING ERRCODE='22023'; END IF;
  LOOP
    scanned:=scanned+1;
    IF scanned>100 THEN RETURN; END IF;
    SELECT * INTO job FROM public.report_pdf_jobs j WHERE j.renderer_id=p_renderer_id
      AND ((j.status='queued' AND j.available_at<=clock_timestamp()) OR (j.status='running' AND j.lease_expires_at<=clock_timestamp()))
      ORDER BY j.available_at,j.requested_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    at_time:=clock_timestamp();
    IF job.status='running' THEN
      UPDATE public.report_pdf_attempts a SET status='expired',completed_at=at_time,error_code='lease_expired',error_message='The previous worker lease expired.'
        WHERE a.organization_id=job.organization_id AND a.job_id=job.id AND a.attempt_number=job.attempts AND a.status='running';
    END IF;
    IF job.attempts>=5 THEN
      UPDATE public.report_pdf_jobs j SET status='failed',lease_token_hash=NULL,lease_expires_at=NULL,completed_at=at_time,
        last_error_code='attempts_exhausted',last_error_message='The report could not be rendered after five attempts.'
        WHERE j.organization_id=job.organization_id AND j.id=job.id;
      CONTINUE;
    END IF;
    token:=gen_random_uuid();
    UPDATE public.report_pdf_jobs j SET status='running',attempts=job.attempts+1,lease_token_hash=sha256(convert_to(token::text,'UTF8')),
      lease_expires_at=at_time+interval '2 minutes',started_at=at_time,completed_at=NULL,last_error_code=NULL,last_error_message=NULL
      WHERE j.organization_id=job.organization_id AND j.id=job.id;
    INSERT INTO public.report_pdf_attempts(organization_id,job_id,attempt_number,worker_id,started_at)
      VALUES(job.organization_id,job.id,job.attempts+1,p_worker_id,at_time);
    RETURN QUERY SELECT job.organization_id,job.id,job.report_id,job.renderer_id,job.attempts+1,token;
    RETURN;
  END LOOP;
END $$;

CREATE FUNCTION report_pdf_begin_read(p_org_id uuid,p_job_id uuid,p_token uuid)
RETURNS TABLE(organization_id uuid,user_id uuid,permission_codes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs; report public.sample_reports;
BEGIN
  job:=public.report_pdf_require_lease(p_org_id,p_job_id,p_token);
  PERFORM 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.organization_id=job.organization_id AND m.user_id=job.requested_by AND m.active AND u.active AND o.active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report requester is no longer active' USING ERRCODE='42501'; END IF;
  PERFORM set_config('app.organization_id',job.organization_id::text,true);
  PERFORM set_config('app.user_id',job.requested_by::text,true);
  SELECT * INTO report FROM public.sample_reports r WHERE r.organization_id=job.organization_id AND r.id=job.report_id;
  IF NOT (public.app_has_permission('samples.read') OR public.app_has_permission('samples.manage')) OR NOT public.report_can_print(report.sample_id) THEN
    RAISE EXCEPTION 'Report print permission was revoked' USING ERRCODE='42501'; END IF;
  PERFORM set_config('app.report_pdf_job_id',job.id::text,true);
  PERFORM set_config('app.report_pdf_lease_hash',encode(job.lease_token_hash,'hex'),true);
  RETURN QUERY SELECT job.organization_id,job.requested_by,ARRAY(SELECT DISTINCT rp.permission_code FROM public.membership_roles mr
    JOIN public.role_permissions rp ON rp.organization_id=mr.organization_id AND rp.role_id=mr.role_id
    WHERE mr.organization_id=job.organization_id AND mr.user_id=job.requested_by ORDER BY rp.permission_code);
END $$;

CREATE FUNCTION report_pdf_context_org() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; job public.report_pdf_jobs;
BEGIN
  SELECT * INTO job FROM public.report_pdf_jobs j WHERE j.organization_id=org AND j.id=nullif(current_setting('app.report_pdf_job_id',true),'')::uuid;
  IF NOT FOUND OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.requested_by::text IS DISTINCT FROM current_setting('app.user_id',true)
    OR encode(job.lease_token_hash,'hex') IS DISTINCT FROM current_setting('app.report_pdf_lease_hash',true) THEN RETURN NULL; END IF;
  RETURN org;
END $$;

CREATE FUNCTION report_pdf_fail(p_org_id uuid,p_job_id uuid,p_token uuid,p_error_code text,p_error_message text,p_retry boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs; at_time timestamptz; retry boolean;
BEGIN
  job:=public.report_pdf_require_lease(p_org_id,p_job_id,p_token);
  at_time:=clock_timestamp(); retry:=coalesce(p_retry,false) AND job.attempts<5;
  UPDATE public.report_pdf_attempts a SET status='failed',completed_at=at_time,error_code=p_error_code,error_message=p_error_message
    WHERE a.organization_id=job.organization_id AND a.job_id=job.id AND a.attempt_number=job.attempts;
  UPDATE public.report_pdf_jobs j SET status=CASE WHEN retry THEN 'queued' ELSE 'failed' END,lease_token_hash=NULL,lease_expires_at=NULL,
    available_at=CASE WHEN retry THEN at_time+make_interval(secs=>power(2,job.attempts)::integer) ELSE j.available_at END,
    completed_at=CASE WHEN retry THEN NULL ELSE at_time END,last_error_code=p_error_code,last_error_message=p_error_message
    WHERE j.organization_id=job.organization_id AND j.id=job.id;
  RETURN true;
END $$;

CREATE FUNCTION report_pdf_complete(p_org_id uuid,p_job_id uuid,p_token uuid,p_content bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs; at_time timestamptz; artifact_id uuid;
BEGIN
  job:=public.report_pdf_require_lease(p_org_id,p_job_id,p_token);
  -- Recheck current permissions after browser rendering and before publication.
  PERFORM * FROM public.report_pdf_begin_read(p_org_id,p_job_id,p_token);
  at_time:=clock_timestamp();
  INSERT INTO public.report_pdf_artifacts(organization_id,report_id,job_id,attempt_number,content,byte_length,sha256,created_at)
    VALUES(job.organization_id,job.report_id,job.id,job.attempts,p_content,octet_length(p_content),sha256(p_content),at_time) RETURNING id INTO artifact_id;
  UPDATE public.report_pdf_attempts a SET status='succeeded',completed_at=at_time WHERE a.organization_id=job.organization_id AND a.job_id=job.id AND a.attempt_number=job.attempts;
  UPDATE public.report_pdf_jobs j SET status='succeeded',lease_token_hash=NULL,lease_expires_at=NULL,completed_at=at_time,last_error_code=NULL,last_error_message=NULL
    WHERE j.organization_id=job.organization_id AND j.id=job.id;
  RETURN artifact_id;
END $$;

CREATE FUNCTION report_pdf_artifact_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Generated PDF artifacts are immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_pdf_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON report_pdf_artifacts FOR EACH ROW EXECUTE FUNCTION report_pdf_artifact_guard();

CREATE FUNCTION report_pdf_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (OLD.status<>'running' OR NEW.status='running'
    OR (NEW.organization_id,NEW.job_id,NEW.attempt_number,NEW.worker_id,NEW.started_at) IS DISTINCT FROM (OLD.organization_id,OLD.job_id,OLD.attempt_number,OLD.worker_id,OLD.started_at)) THEN
    RAISE EXCEPTION 'Completed PDF attempt evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_pdf_attempt_guard BEFORE UPDATE OR DELETE ON report_pdf_attempts FOR EACH ROW EXECUTE FUNCTION report_pdf_attempt_guard();

CREATE FUNCTION report_pdf_consistency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.report_pdf_jobs; target_job_id uuid;
BEGIN
  IF TG_TABLE_NAME='report_pdf_jobs' THEN target_job_id:=NEW.id; ELSE target_job_id:=NEW.job_id; END IF;
  SELECT * INTO job FROM public.report_pdf_jobs j WHERE j.organization_id=NEW.organization_id AND j.id=target_job_id;
  IF job.status='succeeded' THEN
    IF NOT EXISTS (SELECT 1 FROM public.report_pdf_artifacts file JOIN public.report_pdf_attempts attempt
      ON attempt.organization_id=file.organization_id AND attempt.job_id=file.job_id AND attempt.attempt_number=file.attempt_number
      WHERE file.organization_id=job.organization_id AND file.job_id=job.id AND file.attempt_number=job.attempts AND attempt.status='succeeded') THEN
      RAISE EXCEPTION 'A successful PDF job requires its complete artifact and attempt' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS (SELECT 1 FROM public.report_pdf_artifacts file WHERE file.organization_id=job.organization_id AND file.job_id=job.id) THEN
    RAISE EXCEPTION 'PDF artifacts require a successful job' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='report_pdf_attempts' THEN
    IF NEW.status='succeeded' AND (job.status<>'succeeded' OR NEW.attempt_number<>job.attempts) THEN
      RAISE EXCEPTION 'A successful PDF attempt must match the published artifact' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_pdf_job_complete AFTER INSERT OR UPDATE ON report_pdf_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_pdf_consistency_guard();
CREATE CONSTRAINT TRIGGER report_pdf_artifact_complete AFTER INSERT ON report_pdf_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_pdf_consistency_guard();
CREATE CONSTRAINT TRIGGER report_pdf_attempt_complete AFTER INSERT OR UPDATE ON report_pdf_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_pdf_consistency_guard();

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['report_pdf_jobs','report_pdf_attempts','report_pdf_artifacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY report_pdf_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
       AND (SELECT app_has_permission(''samples.read'') OR app_has_permission(''samples.manage'')))',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['sample_reports','sample_report_print_settings','sample_report_tests','analytical_specifications','analytical_specification_limits','datasheet_submissions',
    'templates','template_versions','template_sections','template_rows','template_columns','template_fields','template_numeric_config','template_options','template_expressions',
    'template_expression_nodes','template_repeat_groups','template_instances','template_occurrences','template_values','workflow_runs','workflow_states','workflow_state_capability_roles','membership_roles'] LOOP
    EXECUTE format('GRANT SELECT ON %I TO sampleify_report_worker',relation);
    EXECUTE format('CREATE POLICY report_worker_read ON %I FOR SELECT TO sampleify_report_worker USING (organization_id=(SELECT report_pdf_context_org()))',relation);
  END LOOP;
END $$;
CREATE POLICY report_pdf_job_print_gate ON report_pdf_jobs AS RESTRICTIVE FOR SELECT TO sampleify_app USING
  (EXISTS(SELECT 1 FROM sample_reports report WHERE report.organization_id=report_pdf_jobs.organization_id AND report.id=report_pdf_jobs.report_id AND report_can_print(report.sample_id)));
CREATE POLICY report_pdf_artifact_print_gate ON report_pdf_artifacts AS RESTRICTIVE FOR SELECT TO sampleify_app USING
  (EXISTS(SELECT 1 FROM sample_reports report WHERE report.organization_id=report_pdf_artifacts.organization_id AND report.id=report_pdf_artifacts.report_id AND report_can_print(report.sample_id)));
CREATE POLICY report_pdf_attempt_print_gate ON report_pdf_attempts AS RESTRICTIVE FOR SELECT TO sampleify_app USING
  (EXISTS(SELECT 1 FROM report_pdf_jobs job WHERE job.organization_id=report_pdf_attempts.organization_id AND job.id=report_pdf_attempts.job_id));
GRANT SELECT(organization_id,id,report_id,renderer_id,requested_by,requested_at,status,attempts,available_at,started_at,completed_at,last_error_code,last_error_message) ON report_pdf_jobs TO sampleify_app;
GRANT SELECT ON report_pdf_attempts,report_pdf_artifacts TO sampleify_app;

REVOKE ALL ON FUNCTION report_pdf_enqueue(uuid,text),report_pdf_require_lease(uuid,uuid,uuid),report_pdf_claim(text,uuid),report_pdf_begin_read(uuid,uuid,uuid),report_pdf_context_org(),
  report_pdf_fail(uuid,uuid,uuid,text,text,boolean),report_pdf_complete(uuid,uuid,uuid,bytea),report_pdf_artifact_guard(),report_pdf_attempt_guard(),report_pdf_consistency_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_pdf_enqueue(uuid,text) TO sampleify_app;
GRANT EXECUTE ON FUNCTION report_pdf_claim(text,uuid),report_pdf_begin_read(uuid,uuid,uuid),report_pdf_context_org(),report_pdf_fail(uuid,uuid,uuid,text,text,boolean),report_pdf_complete(uuid,uuid,uuid,bytea) TO sampleify_report_worker;
