CREATE FUNCTION report_can_print(sample_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_state_capability_roles capability
      ON capability.organization_id=run.organization_id AND capability.workflow_state_id=run.current_state_id AND capability.capability='download_report'
    WHERE run.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND run.sample_id=sample_id
  ) THEN EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_state_capability_roles capability
      ON capability.organization_id=run.organization_id AND capability.workflow_state_id=run.current_state_id AND capability.capability='download_report'
    JOIN public.membership_roles assignment ON assignment.organization_id=capability.organization_id AND assignment.role_id=capability.role_id
      AND assignment.user_id=nullif(current_setting('app.user_id', true), '')::uuid
    WHERE run.organization_id=nullif(current_setting('app.organization_id', true), '')::uuid AND run.sample_id=sample_id
  ) ELSE public.app_has_permission('samples.manage') END
$$;
REVOKE ALL ON FUNCTION report_can_print(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_can_print(uuid) TO sampleify_app;

CREATE FUNCTION report_next_number() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  period text := extract(year FROM now() AT TIME ZONE 'UTC')::integer::text;
  next_number bigint; result_prefix text; width integer;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('samples.manage') THEN RAISE EXCEPTION 'Report generation permission required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.number_sequences(organization_id, sequence_key, period_key, prefix, minimum_width)
    VALUES(org, 'sample_report', period, 'COA-' || period || '-', 6) ON CONFLICT DO NOTHING;
  UPDATE public.number_sequences SET next_value=next_value+1
    WHERE organization_id=org AND sequence_key='sample_report' AND period_key=period
    RETURNING next_value-1, prefix, minimum_width INTO next_number, result_prefix, width;
  RETURN result_prefix || lpad(next_number::text, greatest(width, length(next_number::text)), '0');
END $$;
REVOKE ALL ON FUNCTION report_next_number() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_next_number() TO sampleify_app;

CREATE FUNCTION report_lock_sample(sample_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('samples.manage') THEN RAISE EXCEPTION 'Report generation permission required' USING ERRCODE='42501'; END IF;
  -- The stable sample key need not be locked against FK checks from an in-flight
  -- datasheet event. All report generation locks this owner before its requests.
  PERFORM 1 FROM public.samples WHERE organization_id=org AND id=sample_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM request.id FROM public.test_requests request JOIN public.sample_tests test ON test.organization_id=request.organization_id AND test.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=test.organization_id AND product.id=test.sample_product_id
    WHERE product.organization_id=org AND product.sample_id=sample_id ORDER BY request.id FOR NO KEY UPDATE OF request;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION report_lock_sample(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_lock_sample(uuid) TO sampleify_app;

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['sample_reports', 'sample_report_tests', 'sample_report_print_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY report_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'', true), '''')::uuid
        AND (SELECT app_has_permission(''samples.read'') OR app_has_permission(''samples.manage'')))', relation);
    EXECUTE format('CREATE POLICY report_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id=nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''samples.manage'')))', relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sampleify_app', relation);
  END LOOP;
END $$;

CREATE FUNCTION report_guard_snapshot() RETURNS trigger
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
  IF NOT EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id AND kind='report' AND status='frozen')
    OR NOT EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=NEW.organization_id AND event.id=NEW.generated_event_id
      AND event.sample_id=NEW.sample_id AND event.event_type='reports_generated' AND event.actor_user_id=NEW.generated_by
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
CREATE TRIGGER report_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON sample_reports FOR EACH ROW EXECUTE FUNCTION report_guard_snapshot();

CREATE FUNCTION report_guard_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE report public.sample_reports; expected_limit uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Generated report selections are immutable' USING ERRCODE='55000'; END IF;
  IF session_user <> 'sampleify_app' THEN RETURN NEW; END IF;
  SELECT * INTO report FROM public.sample_reports WHERE organization_id=NEW.organization_id AND id=NEW.report_id
    AND generated_by=nullif(current_setting('app.user_id', true), '')::uuid AND xmin::text=pg_current_xact_id()::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report selection must belong to this generation' USING ERRCODE='23514'; END IF;
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
        IS NOT DISTINCT FROM (product.product_code, product.product_name, request.request_number, analyst.display_name, test.is_accredited, request.status, sheet.status, request.completed_at, submission.id, sheet.specification_id)
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
CREATE TRIGGER report_item_guard BEFORE INSERT OR UPDATE OR DELETE ON sample_report_tests FOR EACH ROW EXECUTE FUNCTION report_guard_item();

CREATE FUNCTION report_guard_print_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Generated print settings are immutable' USING ERRCODE='55000'; END IF;
  IF session_user='sampleify_app' AND NOT EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=NEW.organization_id AND id=NEW.report_id
      AND generated_by=nullif(current_setting('app.user_id', true), '')::uuid AND xmin::text=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Print settings must belong to this generation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_print_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON sample_report_print_settings FOR EACH ROW EXECUTE FUNCTION report_guard_print_settings();

CREATE FUNCTION report_require_complete_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item_count integer; first_position integer; last_position integer;
BEGIN
  IF session_user <> 'sampleify_app' THEN RETURN NULL; END IF;
  SELECT count(*), min(display_order), max(display_order) INTO item_count, first_position, last_position FROM public.sample_report_tests WHERE organization_id=NEW.organization_id AND report_id=NEW.id;
  IF item_count=0 OR first_position<>0 OR last_position<>item_count-1 OR NOT EXISTS (
    SELECT 1 FROM public.sample_report_print_settings WHERE organization_id=NEW.organization_id AND report_id=NEW.id
  ) THEN RAISE EXCEPTION 'A generated report needs its complete selection and print settings' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_complete_revision_guard AFTER INSERT ON sample_reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_require_complete_revision();
