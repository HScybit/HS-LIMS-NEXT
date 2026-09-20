-- Step 9: reissuing an already-issued report as a corrected, separately linked
-- document (Meteor's design; PERN has no equivalent). Sample Categories and
-- workflow states already carried inert enable_reissue/show_sample_reissue
-- flags from earlier steps; this is what finally wires them to real behaviour.
-- A reissue never reopens approval: it clones the exact frozen test selection
-- and rendered assets of the report it reissues, and only ever lets the
-- customer name/address/reference change. The original report stays issued
-- and visible; nothing marks it superseded.
-- Unlike is_nabl (0206), every ordinary generation insert already has an
-- unambiguous value here (false), so the default stays instead of forcing
-- every existing call site to spell it out.
ALTER TABLE sample_reports ADD COLUMN is_reissued boolean NOT NULL DEFAULT false;
ALTER TABLE sample_reports ADD COLUMN reissue_source_id uuid;
ALTER TABLE sample_reports ADD COLUMN reissue_batch_id uuid;
ALTER TABLE sample_reports ADD COLUMN reissued_by uuid;
ALTER TABLE sample_reports ADD COLUMN reissued_at timestamptz;
ALTER TABLE sample_reports ADD CONSTRAINT report_reissue_source_fk FOREIGN KEY (organization_id, reissue_source_id) REFERENCES sample_reports(organization_id, id);
ALTER TABLE sample_reports ADD CONSTRAINT report_reissued_actor_fk FOREIGN KEY (organization_id, reissued_by) REFERENCES memberships(organization_id, user_id);
ALTER TABLE sample_reports ADD CONSTRAINT report_reissue CHECK (
  (NOT is_reissued AND reissue_source_id IS NULL AND reissue_batch_id IS NULL AND reissued_by IS NULL AND reissued_at IS NULL)
  OR (is_reissued AND reissue_source_id IS NOT NULL AND reissue_source_id <> id AND reissue_batch_id IS NOT NULL
    AND reissued_by IS NOT NULL AND reissued_at IS NOT NULL AND reissued_at >= generated_at AND is_finalized)
);
CREATE INDEX report_reissue_batch_idx ON sample_reports (organization_id, reissue_batch_id) WHERE is_reissued;
--> statement-breakpoint
ALTER TABLE sample_events DROP CONSTRAINT sample_event_type;
ALTER TABLE sample_events ADD CONSTRAINT sample_event_type CHECK(event_type IN ('sample_registered', 'test_requests_generated', 'test_request_assigned',
  'datasheet_created', 'datasheet_submitted', 'reports_generated', 'reports_finalized', 'report_issued', 'report_reissued', 'datasheet_method_added',
  'datasheet_method_voided', 'test_request_job_created', 'sample_updated'));
--> statement-breakpoint
-- Mirrors report_can_print, adding the Sample Category toggle and the workflow
-- state's own reissue flag on top of the same download_report role gate.
CREATE FUNCTION report_can_reissue(sample_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.report_can_print($1)
    AND EXISTS (SELECT 1 FROM public.samples sample JOIN public.sample_categories category
      ON category.organization_id=sample.organization_id AND category.id=sample.sample_category_id
      WHERE sample.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND sample.id=$1 AND category.enable_reissue)
    AND (NOT EXISTS (SELECT 1 FROM public.workflow_runs run WHERE run.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND run.sample_id=$1)
      OR EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_states state
        ON state.organization_id=run.organization_id AND state.workflow_version_id=run.workflow_version_id AND state.id=run.current_state_id
        WHERE run.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND run.sample_id=$1 AND state.show_sample_reissue))
$$;
GRANT EXECUTE ON FUNCTION report_can_reissue(uuid) TO sampleify_app;
--> statement-breakpoint
-- report_guard_snapshot's normal-generation branch (below the new IF) is
-- byte-for-byte the version this replaces (0205): unrelated to reissue, so it
-- stays untouched. A reissue clone is only ever inserted as 'draft' like any
-- other generation, then promoted to 'issued' through the exact same
-- draft->issued UPDATE transition already defined below (unchanged) — it is
-- deliberately not given its own status transition or supersede behaviour, so
-- the original it reissues is never marked superseded.
CREATE OR REPLACE FUNCTION report_guard_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sample public.samples; previous public.sample_reports; require_approved boolean; source public.sample_reports;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Generated report revisions are immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.organization_id, OLD.id, OLD.sample_id, OLD.template_version_id, OLD.report_number, OLD.revision, OLD.report_type, OLD.group_key,
        OLD.sample_product_id, OLD.sample_test_id, OLD.product_context_line_id, OLD.generated_by, OLD.generated_at, OLD.generated_event_id, OLD.is_finalized,
        OLD.sample_revision, OLD.sample_number, OLD.sample_type, OLD.sample_category_name, OLD.customer_name, OLD.customer_address,
        OLD.customer_reference, OLD.received_at, OLD.registered_at, OLD.due_at, OLD.description,
        OLD.is_reissued, OLD.reissue_source_id, OLD.reissue_batch_id, OLD.reissued_by, OLD.reissued_at) IS DISTINCT FROM
      (NEW.organization_id, NEW.id, NEW.sample_id, NEW.template_version_id, NEW.report_number, NEW.revision, NEW.report_type, NEW.group_key,
        NEW.sample_product_id, NEW.sample_test_id, NEW.product_context_line_id, NEW.generated_by, NEW.generated_at, NEW.generated_event_id, NEW.is_finalized,
        NEW.sample_revision, NEW.sample_number, NEW.sample_type, NEW.sample_category_name, NEW.customer_name, NEW.customer_address,
        NEW.customer_reference, NEW.received_at, NEW.registered_at, NEW.due_at, NEW.description,
        NEW.is_reissued, NEW.reissue_source_id, NEW.reissue_batch_id, NEW.reissued_by, NEW.reissued_at)
    THEN RAISE EXCEPTION 'Generated report revisions are immutable' USING ERRCODE='55000'; END IF;
    IF session_user <> 'sampleify_app' THEN RETURN NEW; END IF;
    IF OLD.status='draft' AND NEW.status='issued' THEN
      IF NOT NEW.is_finalized OR NEW.issued_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid OR NEW.issued_at IS DISTINCT FROM now()
        OR NOT public.app_has_permission('samples.manage') OR NOT public.report_can_print(NEW.sample_id)
        OR EXISTS (SELECT 1 FROM public.sample_report_tests test WHERE test.organization_id=NEW.organization_id AND test.report_id=NEW.id
          AND (test.request_status<>'approved' OR test.datasheet_status<>'approved'))
      THEN RAISE EXCEPTION 'Report issue is not allowed' USING ERRCODE='42501'; END IF;
      RETURN NEW;
    ELSIF OLD.status='issued' AND NEW.status='superseded' THEN
      IF NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NOT public.app_has_permission('samples.manage') THEN
        RAISE EXCEPTION 'Report supersession is not allowed' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Generated report revisions are immutable' USING ERRCODE='55000';
  END IF;
  IF session_user <> 'sampleify_app' THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR NEW.generated_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
    OR NEW.generated_at IS DISTINCT FROM now() OR NEW.status <> 'draft'
    OR NOT public.app_has_permission('samples.manage') OR NOT public.report_can_print(NEW.sample_id) THEN
    RAISE EXCEPTION 'Report generation is not allowed' USING ERRCODE='42501';
  END IF;
  IF NEW.is_reissued THEN
    IF NOT public.report_can_reissue(NEW.sample_id) THEN RAISE EXCEPTION 'Report reissue is not allowed' USING ERRCODE='42501'; END IF;
    SELECT * INTO source FROM public.sample_reports WHERE organization_id=NEW.organization_id AND id=NEW.reissue_source_id
      AND sample_id=NEW.sample_id AND status='issued' AND NOT is_reissued;
    IF NOT FOUND OR NEW.reissued_by IS DISTINCT FROM NEW.generated_by OR NEW.reissued_at IS DISTINCT FROM NEW.generated_at
      OR NEW.revision <= source.revision OR NOT NEW.is_finalized
      OR (NEW.template_version_id, NEW.report_number, NEW.report_type, NEW.group_key, NEW.sample_product_id, NEW.sample_test_id, NEW.is_nabl,
          NEW.sample_revision, NEW.sample_number, NEW.sample_type, NEW.sample_category_name, NEW.received_at, NEW.registered_at, NEW.due_at, NEW.description)
        IS DISTINCT FROM (source.template_version_id, source.report_number, source.report_type, source.group_key, source.sample_product_id, source.sample_test_id, source.is_nabl,
          source.sample_revision, source.sample_number, source.sample_type, source.sample_category_name, source.received_at, source.registered_at, source.due_at, source.description)
    THEN RAISE EXCEPTION 'Reissued report must preserve its source report exactly, aside from allowed edits' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=NEW.organization_id AND event.id=NEW.generated_event_id
      AND event.sample_id=NEW.sample_id AND event.event_type='report_reissued' AND event.actor_user_id=NEW.generated_by
      AND event.occurred_at=NEW.generated_at AND event.xmin::text=pg_current_xact_id()::text)
    THEN RAISE EXCEPTION 'Report provenance is invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
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
--> statement-breakpoint
-- report_guard_item's live-state branch (below the new IF) is byte-for-byte
-- the version this replaces (0206, already corrected to compare against
-- submission.specification_id): unrelated to reissue, so it stays untouched.
-- A reissued line is instead checked against the exact line it was cloned
-- from, so a reissue can never pick up drift in live product/analyst/request
-- data between the original issue and the reissue.
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
  IF report.is_reissued THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.sample_report_tests source
      WHERE source.organization_id = NEW.organization_id AND source.report_id = report.reissue_source_id AND source.sample_test_id = NEW.sample_test_id
        AND (NEW.sample_product_id, NEW.test_request_id, NEW.submission_id, NEW.specification_id, NEW.decision_limit_id, NEW.display_order,
             NEW.product_code, NEW.product_name, NEW.request_number, NEW.analyst_name, NEW.is_accredited, NEW.request_status, NEW.datasheet_status, NEW.completed_at)
          IS NOT DISTINCT FROM (source.sample_product_id, source.test_request_id, source.submission_id, source.specification_id, source.decision_limit_id, source.display_order,
             source.product_code, source.product_name, source.request_number, source.analyst_name, source.is_accredited, source.request_status, source.datasheet_status, source.completed_at)
    ) THEN RAISE EXCEPTION 'Reissued report line must match its source report exactly' USING ERRCODE='23514'; END IF;
    RETURN NEW;
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
--> statement-breakpoint
-- report_snapshot_assets's live-resolution branch (below the new IF) is
-- byte-for-byte the version this replaces (0084): unrelated to reissue, so it
-- stays untouched. A reissued report copies its source's exact captured
-- assets instead of re-resolving the organization's current defaults, which
-- may have changed since the original was issued.
CREATE OR REPLACE FUNCTION report_snapshot_assets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE definition public.template_versions; chosen record; version public.report_document_versions;
  header_id uuid; footer_id uuid; nabl_header_id uuid; nabl_footer_id uuid; css_id uuid; source public.sample_report_assets;
BEGIN
  IF NEW.is_reissued THEN
    SELECT * INTO source FROM public.sample_report_assets WHERE organization_id=NEW.organization_id AND report_id=NEW.reissue_source_id;
    INSERT INTO public.sample_report_assets(organization_id,report_id,header_version_id,footer_version_id,nabl_header_version_id,nabl_footer_version_id,css_version_id)
      VALUES(NEW.organization_id,NEW.id,source.header_version_id,source.footer_version_id,source.nabl_header_version_id,source.nabl_footer_version_id,source.css_version_id);
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('report-documents:'||NEW.organization_id::text,0));
  SELECT * INTO definition FROM public.template_versions WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id;
  FOR chosen IN SELECT * FROM (VALUES ('header',definition.header_document_id),('footer',definition.footer_document_id),
    ('nablHeader',definition.nabl_header_document_id),('nablFooter',definition.nabl_footer_document_id)) selected(slot,id) WHERE id IS NOT NULL LOOP
    SELECT * INTO version FROM public.report_document_versions item WHERE item.organization_id=NEW.organization_id AND item.document_id=chosen.id ORDER BY item.revision DESC LIMIT 1;
    IF NOT FOUND OR version.is_retired THEN
      RAISE EXCEPTION 'A selected report asset is unavailable' USING ERRCODE='23514',CONSTRAINT='report_asset_unavailable';
    END IF;
    CASE chosen.slot WHEN 'header' THEN header_id:=version.id; WHEN 'footer' THEN footer_id:=version.id;
      WHEN 'nablHeader' THEN nabl_header_id:=version.id; WHEN 'nablFooter' THEN nabl_footer_id:=version.id; END CASE;
  END LOOP;
  SELECT id INTO css_id FROM public.organization_custom_css_versions WHERE organization_id=NEW.organization_id ORDER BY revision DESC LIMIT 1;
  INSERT INTO public.sample_report_assets(organization_id,report_id,header_version_id,footer_version_id,nabl_header_version_id,nabl_footer_version_id,css_version_id)
    VALUES(NEW.organization_id,NEW.id,header_id,footer_id,nabl_header_id,nabl_footer_id,css_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Everything below the new is_reissued clause is byte-for-byte the version
-- this replaces (0075): unrelated to reissue, so it stays untouched. A
-- reissued report is marked is_finalized so it can be issued through the
-- ordinary draft->issued transition, but it is not itself a finalizing
-- generation event, so it needs no matching sample_report_finalizations
-- receipt in this transaction the way a real one would.
CREATE OR REPLACE FUNCTION report_require_finalization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE finalization_event uuid; receipt public.sample_report_finalizations;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='sample_reports' THEN
    IF NOT NEW.is_finalized OR NEW.is_reissued THEN RETURN NULL; END IF;
    finalization_event := NEW.generated_event_id;
  ELSIF TG_TABLE_NAME='sample_events' THEN
    IF NEW.event_type<>'reports_finalized' THEN RETURN NULL; END IF;
    finalization_event := NEW.id;
  ELSE
    finalization_event := NEW.event_id;
  END IF;
  SELECT * INTO receipt FROM public.sample_report_finalizations WHERE organization_id=NEW.organization_id AND event_id=finalization_event;
  IF NOT FOUND OR receipt.transaction_id<>pg_current_xact_id() OR receipt.finalized_at<>now()
    OR receipt.finalized_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.samples WHERE organization_id=receipt.organization_id AND id=receipt.sample_id
      AND status='completed' AND revision=receipt.completed_revision)
    OR NOT EXISTS (SELECT 1 FROM public.sample_events WHERE organization_id=receipt.organization_id AND id=receipt.event_id
      AND sample_id=receipt.sample_id AND event_type='reports_finalized' AND actor_user_id=receipt.finalized_by AND occurred_at=receipt.finalized_at)
    OR NOT EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=receipt.organization_id AND generated_event_id=receipt.event_id)
    OR EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=receipt.organization_id AND generated_event_id=receipt.event_id
      AND (NOT is_finalized OR sample_id<>receipt.sample_id OR sample_revision<>receipt.previous_revision
        OR generated_by<>receipt.finalized_by OR generated_at<>receipt.finalized_at)) THEN
    RAISE EXCEPTION 'Finalised reports require matching sample completion evidence' USING ERRCODE='23514',CONSTRAINT='report_finalization_complete';
  END IF;
  RETURN NULL;
END $$;
