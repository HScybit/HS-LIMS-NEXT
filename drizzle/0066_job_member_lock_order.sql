-- Save commands already hold a shared job lock before locking the capture.
-- Do not upgrade that lock after a capture lock: another save can hold the
-- same shared job lock while waiting for this capture. Submission commands
-- already hold their exclusive parent lock through laboratory_lock_datasheet.
CREATE OR REPLACE FUNCTION laboratory_lock_job_members(sheet_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; job_id uuid;
BEGIN
  SELECT job.id INTO job_id FROM public.datasheets sheet JOIN public.test_requests job ON job.organization_id=sheet.organization_id AND job.id=sheet.test_request_id AND job.is_job
    WHERE sheet.organization_id=org AND sheet.id=sheet_id;
  IF job_id IS NULL OR NOT public.laboratory_request_can_work(job_id) THEN RAISE EXCEPTION 'Current assigned job access required' USING ERRCODE='42501'; END IF;
  PERFORM public.laboratory_lock_request_sample(job_id);
  PERFORM 1 FROM public.test_requests WHERE organization_id=org AND parent_test_request_id=job_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.datasheets sheet JOIN public.test_requests child ON child.organization_id=sheet.organization_id AND child.id=sheet.test_request_id
    WHERE child.organization_id=org AND child.parent_test_request_id=job_id ORDER BY sheet.id FOR UPDATE OF sheet;
  PERFORM 1 FROM public.template_instances capture JOIN public.datasheets sheet ON sheet.organization_id=capture.organization_id AND sheet.template_instance_id=capture.id
    JOIN public.test_requests child ON child.organization_id=sheet.organization_id AND child.id=sheet.test_request_id
    WHERE child.organization_id=org AND child.parent_test_request_id=job_id ORDER BY capture.id FOR UPDATE OF capture;
END $$;
