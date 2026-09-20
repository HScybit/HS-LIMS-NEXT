-- Preserve grouped rows in one generation while rejecting a later generation after finalization.
CREATE OR REPLACE FUNCTION report_guard_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sample public.samples; previous public.sample_reports; require_approved boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Generated report revisions are immutable' USING ERRCODE='55000'; END IF;
  IF session_user <> 'sampleify_app' THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR NEW.generated_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
    OR NEW.generated_at IS DISTINCT FROM now() OR NEW.status <> 'draft'
    OR NOT public.app_has_permission('samples.manage') OR NOT public.report_can_print(NEW.sample_id) THEN
    RAISE EXCEPTION 'Report generation is not allowed' USING ERRCODE='42501';
  END IF;
  SELECT * INTO sample FROM public.samples WHERE organization_id=NEW.organization_id AND id=NEW.sample_id FOR NO KEY UPDATE;
  IF NOT FOUND OR sample.status='cancelled' OR
    (NEW.sample_revision, NEW.sample_number, NEW.sample_type, NEW.sample_category_name, NEW.customer_name, NEW.customer_address,
      NEW.customer_reference, NEW.received_at, NEW.registered_at, NEW.due_at, NEW.description) IS DISTINCT FROM
    (sample.revision, sample.sample_number, sample.sample_type, sample.category_name, sample.customer_name, sample.customer_address,
      sample.customer_reference, sample.received_at, sample.registered_at, sample.due_at, sample.description) THEN
    RAISE EXCEPTION 'Report sample snapshot does not match' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sample_report_finalizations
      WHERE organization_id=NEW.organization_id AND sample_id=NEW.sample_id)
    OR EXISTS (SELECT 1 FROM public.sample_reports
      WHERE organization_id=NEW.organization_id AND sample_id=NEW.sample_id AND is_finalized
        AND generated_event_id<>NEW.generated_event_id) THEN
    RAISE EXCEPTION 'Reports for this sample are already finalised'
      USING ERRCODE='23514',CONSTRAINT='report_already_finalized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id AND kind='report' AND status='frozen')
    OR NOT EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=NEW.organization_id AND event.id=NEW.generated_event_id
      AND event.sample_id=NEW.sample_id AND event.event_type=CASE WHEN NEW.is_finalized THEN 'reports_finalized' ELSE 'reports_generated' END AND event.actor_user_id=NEW.generated_by
      AND event.occurred_at=NEW.generated_at AND event.xmin::text=pg_current_xact_id()::text)
    OR NEW.sample_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.sample_product_id AND sample_id=NEW.sample_id)
    OR NEW.sample_test_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sample_tests WHERE organization_id=NEW.organization_id AND id=NEW.sample_test_id AND sample_product_id=NEW.sample_product_id) THEN
    RAISE EXCEPTION 'Report provenance is invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO previous FROM public.sample_reports WHERE organization_id=NEW.organization_id AND sample_id=NEW.sample_id AND group_key=NEW.group_key ORDER BY revision DESC LIMIT 1;
  IF NEW.revision IS DISTINCT FROM coalesce(previous.revision, 0)+1 OR previous.id IS NOT NULL AND NEW.report_number IS DISTINCT FROM previous.report_number THEN
    RAISE EXCEPTION 'Report revision changed' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(bool_or(state.require_all_test_requests_approved), false) OR NOT EXISTS (
      SELECT 1 FROM public.workflow_runs run JOIN public.workflow_state_capability_roles capability
        ON capability.organization_id=run.organization_id AND capability.workflow_state_id=run.current_state_id AND capability.capability='download_report'
      WHERE run.organization_id=NEW.organization_id AND run.sample_id=NEW.sample_id)
    INTO require_approved FROM public.workflow_runs run JOIN public.workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE run.organization_id=NEW.organization_id AND run.sample_id=NEW.sample_id;
  IF require_approved AND EXISTS (SELECT 1 FROM public.sample_products product JOIN public.sample_tests test ON test.organization_id=product.organization_id AND test.sample_product_id=product.id
    LEFT JOIN LATERAL (SELECT * FROM public.test_requests request WHERE request.organization_id=test.organization_id AND request.sample_test_id=test.id ORDER BY request.attempt_number DESC LIMIT 1) request ON true
    LEFT JOIN public.datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id
    WHERE product.organization_id=NEW.organization_id AND product.sample_id=NEW.sample_id AND test.status <> 'cancelled'
      AND (test.status <> 'completed' OR sheet.status IS DISTINCT FROM 'approved')) THEN
    RAISE EXCEPTION 'Approve all test requests before generating reports' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
