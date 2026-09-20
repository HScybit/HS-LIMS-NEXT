ALTER TABLE datasheet_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY submission_read ON datasheet_submissions FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT laboratory_can_read()));
CREATE POLICY submission_insert ON datasheet_submissions FOR INSERT TO sampleify_app WITH CHECK
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('datasheets.execute')));
GRANT SELECT, INSERT ON datasheet_submissions TO sampleify_app;
CREATE TRIGGER submission_append_only BEFORE UPDATE OR DELETE ON datasheet_submissions
  FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

-- All request/capture mutations lock the owner first. This serializes submission
-- against saves, reassignment, approval requests and alternate result selection.
CREATE FUNCTION laboratory_lock_datasheet(sheet_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  request_id uuid; capture_id uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('datasheets.execute') THEN RAISE EXCEPTION 'Datasheet execution permission required' USING ERRCODE = '42501'; END IF;
  SELECT test_request_id INTO request_id FROM public.datasheets WHERE organization_id=org AND id=sheet_id;
  IF request_id IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=request_id FOR UPDATE;
  SELECT template_instance_id INTO capture_id FROM public.datasheets WHERE organization_id=org AND id=sheet_id FOR UPDATE;
  PERFORM 1 FROM public.template_instances WHERE organization_id=org AND id=capture_id FOR UPDATE;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION laboratory_lock_datasheet(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_lock_datasheet(uuid) TO sampleify_app;

CREATE FUNCTION laboratory_guard_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sheet public.datasheets; capture public.template_instances; selected public.template_values;
  field public.template_fields; unit public.measurement_units; specification public.analytical_specifications;
  scalar_text text; expected_number integer; current_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  SELECT * INTO sheet FROM public.datasheets WHERE organization_id=NEW.organization_id AND id=NEW.datasheet_id;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id=NEW.organization_id AND id=NEW.instance_id;
  SELECT * INTO selected FROM public.template_values WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id
    AND field_id=NEW.field_id AND occurrence_id=NEW.occurrence_id AND revision<=NEW.capture_revision ORDER BY revision DESC LIMIT 1;
  SELECT * INTO field FROM public.template_fields WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=NEW.field_id;
  SELECT coalesce(max(number),0)+1 INTO expected_number FROM public.datasheet_submissions WHERE organization_id=NEW.organization_id AND datasheet_id=NEW.datasheet_id;
  IF sheet.id IS NULL OR capture.id IS NULL OR field.id IS NULL OR selected.field_id IS NULL
    OR sheet.template_instance_id IS DISTINCT FROM NEW.instance_id OR capture.version_id IS DISTINCT FROM NEW.version_id
    OR capture.status<>'frozen' OR NEW.capture_revision<>capture.revision OR NEW.number<>expected_number
    OR selected.revision IS DISTINCT FROM NEW.value_revision OR selected.state NOT IN ('present','not_applicable')
    OR NOT EXISTS (SELECT 1 FROM public.template_occurrences WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id
      AND id=NEW.occurrence_id AND created_revision<=NEW.capture_revision AND (removed_revision IS NULL OR removed_revision>NEW.capture_revision)) THEN
    RAISE EXCEPTION 'Submission must pin the current frozen capture and its latest active value' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.template_columns column_detail JOIN public.template_rows row_detail
    ON row_detail.organization_id=column_detail.organization_id AND row_detail.version_id=column_detail.version_id AND row_detail.id=column_detail.row_id
    JOIN public.template_sections section ON section.organization_id=row_detail.organization_id AND section.version_id=row_detail.version_id AND section.id=row_detail.section_id
    WHERE column_detail.organization_id=NEW.organization_id AND column_detail.version_id=NEW.version_id AND column_detail.id=field.column_id
      AND ((NEW.source='column' AND column_detail.is_final_result) OR (NEW.source='section' AND section.is_final_result AND field.widget IN ('input_widget','formula_widget','result_widget')))) THEN
    RAISE EXCEPTION 'The selected value is not a final result in this template version' USING ERRCODE = '23514';
  END IF;
  IF selected.state='not_applicable' THEN scalar_text := 'NA';
  ELSIF selected.value_type='text' THEN scalar_text := selected.text_value;
  ELSIF selected.value_type='date' THEN scalar_text := selected.date_value::text;
  ELSIF selected.value_type='option' THEN
    SELECT value INTO scalar_text FROM public.template_options WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND field_id=NEW.field_id AND id=selected.option_id;
  END IF;
  IF selected.state='present' AND selected.value_type='boolean' THEN
    IF NEW.result_type<>'boolean' OR NEW.boolean_value IS DISTINCT FROM selected.boolean_value THEN RAISE EXCEPTION 'Submitted boolean differs from recorded value' USING ERRCODE='23514'; END IF;
  ELSIF selected.state='present' AND selected.value_type='numeric' THEN
    IF NEW.result_type<>'numeric' OR NEW.number_value IS DISTINCT FROM selected.number_value THEN RAISE EXCEPTION 'Submitted number differs from recorded value' USING ERRCODE='23514'; END IF;
  ELSIF btrim(scalar_text) ~ '^-?[0-9]+([.][0-9]+)?$' THEN
    IF NEW.result_type<>'numeric' OR NEW.number_value IS DISTINCT FROM btrim(scalar_text)::numeric THEN RAISE EXCEPTION 'Submitted number differs from recorded text' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.result_type<>'text' OR NEW.text_value IS DISTINCT FROM scalar_text THEN RAISE EXCEPTION 'Submitted text differs from recorded value' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.measurement_unit_id IS NOT NULL THEN
    SELECT * INTO specification FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=sheet.specification_id;
    IF NEW.measurement_unit_id=specification.measurement_unit_id THEN
      IF (NEW.unit_revision,NEW.unit_code,NEW.unit_name,NEW.unit_symbol,NEW.unit_dimension) IS DISTINCT FROM
        (specification.unit_revision,specification.unit_code,specification.unit_name,specification.unit_symbol,specification.unit_dimension) THEN
        RAISE EXCEPTION 'Submitted unit must retain the pinned scientific specification' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO unit FROM public.measurement_units WHERE organization_id=NEW.organization_id AND id=NEW.measurement_unit_id FOR SHARE;
      IF unit.id IS NULL OR NOT unit.active OR (NEW.unit_revision,NEW.unit_code,NEW.unit_name,NEW.unit_symbol,NEW.unit_dimension) IS DISTINCT FROM
        (unit.revision,unit.code,unit.name,unit.symbol,unit.dimension) THEN RAISE EXCEPTION 'Submitted unit snapshot is invalid' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  IF session_user='sampleify_app' THEN
    IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid OR NEW.submitted_by IS DISTINCT FROM current_actor
      OR NOT public.app_has_permission('datasheets.execute') OR sheet.status NOT IN ('in_progress','rejected')
      OR NOT EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=NEW.organization_id AND test_request_id=sheet.test_request_id
        AND assignment_type='analyst' AND assigned_user_id=current_actor AND unassigned_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM public.template_instances WHERE organization_id=NEW.organization_id AND id=NEW.instance_id AND xmin::text=pg_current_xact_id()::text)
      OR NOT EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=sheet.test_request_id AND status IN ('allocated','in_progress','rejected'))
      OR EXISTS (SELECT 1 FROM public.approval_cases approval JOIN public.workflow_runs run ON run.organization_id=approval.organization_id AND run.id=approval.workflow_run_id
        WHERE run.organization_id=NEW.organization_id AND run.test_request_id=sheet.test_request_id AND approval.status='pending') THEN
      RAISE EXCEPTION 'Only the assigned analyst can submit an open datasheet' USING ERRCODE='42501';
    END IF;
    NEW.submitted_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submission_record_guard BEFORE INSERT ON datasheet_submissions FOR EACH ROW EXECUTE FUNCTION laboratory_guard_submission();

CREATE FUNCTION laboratory_submission_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests request
    ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id JOIN public.template_instances capture
    ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    WHERE sheet.organization_id=NEW.organization_id AND sheet.id=NEW.datasheet_id AND sheet.latest_submission_id=NEW.id
      AND sheet.status IN ('under_review','approved') AND sheet.completed_by=NEW.submitted_by AND sheet.completed_at=NEW.submitted_at
      AND request.final_datasheet_id=sheet.id AND request.status IN ('under_review','approved') AND capture.status='frozen' AND capture.revision=NEW.capture_revision
      AND EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=sheet.organization_id AND event.test_request_id=request.id
        AND event.event_type='datasheet_submitted' AND event.actor_user_id=NEW.submitted_by AND event.xmin::text=pg_current_xact_id()::text)) THEN
    RAISE EXCEPTION 'Submission, frozen capture, owner status and actual audit event must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER submission_complete AFTER INSERT ON datasheet_submissions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_submission_complete();

CREATE FUNCTION laboratory_guard_submission_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user='sampleify_app' AND NEW.latest_submission_id IS DISTINCT FROM OLD.latest_submission_id THEN
    IF NEW.status<>'under_review' OR NOT EXISTS (SELECT 1 FROM public.datasheet_submissions WHERE organization_id=NEW.organization_id AND datasheet_id=NEW.id
      AND id=NEW.latest_submission_id AND submitted_by=nullif(current_setting('app.user_id', true), '')::uuid AND xmin::text=pg_current_xact_id()::text) THEN
      RAISE EXCEPTION 'Current result must be an actual new submission' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER datasheet_submission_link_guard BEFORE UPDATE ON datasheets FOR EACH ROW EXECUTE FUNCTION laboratory_guard_submission_link();
