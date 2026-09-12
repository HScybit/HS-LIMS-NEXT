-- An applied parent action can be in a different frozen workflow definition.
-- Its child must not execute an edge from the child's previous graph while
-- the parent decision governs that submission. Continue through the real job.
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
  IF EXISTS (SELECT 1 FROM public.laboratory_job_workflow_effects effect
    WHERE effect.organization_id=org AND effect.child_workflow_run_id=selected_run AND effect.is_current
      AND effect.target_state_type NOT IN ('final','cancelled')) THEN
    RAISE EXCEPTION 'Continue this review from the parent job' USING ERRCODE='23514', CONSTRAINT='workflow_parent_job_controls';
  END IF;
  RETURN true;
END $$;
