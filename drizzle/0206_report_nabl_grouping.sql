-- Step 9 (Q5, 2026-09-18): follow Meteor's per-test NABL split rather than PERN's
-- all-or-nothing rule — a selection mixing accredited and non-accredited tests now
-- produces two separate report documents instead of one document that loses its
-- NABL marking entirely because of a single non-accredited test. is_nabl records
-- which variant a report is; the group key always names it explicitly so a
-- product/consolidated group's revision history is scoped per accreditation split.
ALTER TABLE sample_reports ADD COLUMN is_nabl boolean NOT NULL DEFAULT false;
ALTER TABLE sample_reports ALTER COLUMN is_nabl DROP DEFAULT;
ALTER TABLE sample_reports DROP CONSTRAINT report_group;
ALTER TABLE sample_reports ADD CONSTRAINT report_group CHECK (
  (report_type = 'consolidated' AND group_key = 'consolidated:' || (CASE WHEN is_nabl THEN 'nabl' ELSE 'non_nabl' END) AND sample_product_id IS NULL AND sample_test_id IS NULL)
  OR (report_type = 'product_wise' AND sample_product_id IS NOT NULL AND sample_test_id IS NULL AND group_key = 'product:' || sample_product_id::text || ':' || (CASE WHEN is_nabl THEN 'nabl' ELSE 'non_nabl' END))
  OR (report_type = 'parameter_wise' AND sample_product_id IS NOT NULL AND sample_test_id IS NOT NULL AND group_key = 'parameter:' || sample_test_id::text || ':' || (CASE WHEN is_nabl THEN 'nabl' ELSE 'non_nabl' END))
);
--> statement-breakpoint
-- report_guard_item() already re-verifies NEW.is_accredited against the live sample_tests
-- row on every insert; this only adds that a report's own is_nabl must match every test it
-- actually contains, so a report can never end up NABL-marked with a non-accredited test.
CREATE OR REPLACE FUNCTION report_guard_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE report public.sample_reports; expected_limit uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Generated report selections are immutable' USING ERRCODE='55000'; END IF;
  IF session_user <> 'sampleify_app' THEN RETURN NEW; END IF;
  SELECT * INTO report FROM public.sample_reports WHERE organization_id=NEW.organization_id AND id=NEW.report_id
    AND generated_by=nullif(current_setting('app.user_id', true), '')::uuid AND xmin::text=pg_current_xact_id()::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report selection must belong to this generation' USING ERRCODE='23514'; END IF;
  IF NEW.is_accredited IS DISTINCT FROM report.is_nabl THEN
    RAISE EXCEPTION 'Report selection accreditation does not match its NABL grouping' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sample_products product JOIN public.sample_tests test
      ON test.organization_id=product.organization_id AND test.sample_product_id=product.id
    JOIN public.test_requests request ON request.organization_id=test.organization_id AND request.sample_test_id=test.id AND request.id=NEW.test_request_id
    JOIN public.datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id AND sheet.test_request_id=request.id
    JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.id=sheet.latest_submission_id AND submission.datasheet_id=sheet.id
    JOIN public.template_instances capture ON capture.organization_id=submission.organization_id AND capture.id=submission.instance_id AND capture.status='frozen'
      AND capture.version_id=submission.version_id AND capture.revision=submission.capture_revision
    JOIN public.users analyst ON analyst.id=submission.submitted_by
    WHERE product.organization_id=NEW.organization_id AND product.sample_id=report.sample_id AND product.id=NEW.sample_product_id AND test.id=NEW.sample_test_id AND test.status <> 'cancelled'
      AND (report.sample_product_id IS NULL OR report.sample_product_id=product.id) AND (report.sample_test_id IS NULL OR report.sample_test_id=test.id)
      AND (NEW.product_code, NEW.product_name, NEW.request_number, NEW.analyst_name, NEW.is_accredited, NEW.request_status, NEW.datasheet_status, NEW.completed_at, NEW.submission_id, NEW.specification_id)
        IS NOT DISTINCT FROM (product.product_code, product.product_name, request.request_number, analyst.display_name, test.is_accredited, request.status, sheet.status, request.completed_at, submission.id, submission.specification_id)
      AND NOT EXISTS (SELECT 1 FROM public.test_requests newer WHERE newer.organization_id=request.organization_id AND newer.sample_test_id=request.sample_test_id AND newer.attempt_number>request.attempt_number)
  ) THEN RAISE EXCEPTION 'Report result does not match the selected frozen submission' USING ERRCODE='23514'; END IF;
  SELECT boundary.id INTO expected_limit FROM public.analytical_specification_limits boundary JOIN public.datasheet_submissions submission
    ON submission.organization_id=boundary.organization_id AND submission.id=NEW.submission_id
    WHERE boundary.organization_id=NEW.organization_id AND boundary.specification_id=NEW.specification_id AND submission.result_type='numeric'
      AND (boundary.lower_limit IS NULL OR CASE WHEN boundary.lower_inclusive THEN submission.number_value>=boundary.lower_limit ELSE submission.number_value>boundary.lower_limit END)
      AND (boundary.upper_limit IS NULL OR CASE WHEN boundary.upper_inclusive THEN submission.number_value<=boundary.upper_limit ELSE submission.number_value<boundary.upper_limit END)
    ORDER BY boundary.display_order, boundary.id LIMIT 1;
  IF NEW.decision_limit_id IS DISTINCT FROM expected_limit THEN RAISE EXCEPTION 'Report interpretation does not match the frozen specification' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
