-- Qualify the sample argument so it cannot bind to a joined sample_id column.
-- Forward correction: migration 0043 is already applied and remains unchanged.

CREATE OR REPLACE FUNCTION report_can_print(sample_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.samples sample WHERE sample.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND sample.id=$1) AND CASE WHEN EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_state_capability_roles capability
      ON capability.organization_id=run.organization_id AND capability.workflow_state_id=run.current_state_id AND capability.capability='download_report'
    WHERE run.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND run.sample_id=$1
  ) THEN EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_state_capability_roles capability
      ON capability.organization_id=run.organization_id AND capability.workflow_state_id=run.current_state_id AND capability.capability='download_report'
    JOIN public.membership_roles assignment ON assignment.organization_id=capability.organization_id AND assignment.role_id=capability.role_id
      AND assignment.user_id=nullif(current_setting('app.user_id', true), '')::uuid
    WHERE run.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND run.sample_id=$1
  ) ELSE public.app_has_permission('samples.manage') END
$$;

CREATE OR REPLACE FUNCTION report_lock_sample(sample_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('samples.manage') THEN RAISE EXCEPTION 'Report generation permission required' USING ERRCODE='42501'; END IF;
  -- The stable sample key need not be locked against FK checks from an in-flight
  -- datasheet event. All report generation locks this owner before its requests.
  PERFORM 1 FROM public.samples WHERE organization_id=org AND id=report_lock_sample.sample_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM request.id FROM public.test_requests request JOIN public.sample_tests test ON test.organization_id=request.organization_id AND test.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=test.organization_id AND product.id=test.sample_product_id
    WHERE product.organization_id=org AND product.sample_id=report_lock_sample.sample_id ORDER BY request.id FOR NO KEY UPDATE OF request;
  RETURN true;
END $$;
