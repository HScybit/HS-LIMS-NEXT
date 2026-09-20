CREATE FUNCTION laboratory_lock_job_members(sheet_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; job_id uuid;
BEGIN
  SELECT job.id INTO job_id FROM public.datasheets sheet JOIN public.test_requests job ON job.organization_id=sheet.organization_id AND job.id=sheet.test_request_id AND job.is_job
    WHERE sheet.organization_id=org AND sheet.id=sheet_id;
  IF job_id IS NULL OR NOT public.laboratory_request_can_work(job_id) THEN RAISE EXCEPTION 'Current assigned job access required' USING ERRCODE='42501'; END IF;
  PERFORM public.laboratory_lock_request_sample(job_id);
  PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=job_id FOR UPDATE;
  PERFORM 1 FROM public.test_requests WHERE organization_id=org AND parent_test_request_id=job_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.datasheets sheet JOIN public.test_requests child ON child.organization_id=sheet.organization_id AND child.id=sheet.test_request_id
    WHERE child.organization_id=org AND child.parent_test_request_id=job_id ORDER BY sheet.id FOR UPDATE OF sheet;
  PERFORM 1 FROM public.template_instances capture JOIN public.datasheets sheet ON sheet.organization_id=capture.organization_id AND sheet.template_instance_id=capture.id
    JOIN public.test_requests child ON child.organization_id=sheet.organization_id AND child.id=sheet.test_request_id
    WHERE child.organization_id=org AND child.parent_test_request_id=job_id ORDER BY capture.id FOR UPDATE OF capture;
END $$;
GRANT EXECUTE ON FUNCTION laboratory_lock_job_members(uuid) TO sampleify_app;

CREATE FUNCTION laboratory_group_submission_for_request(request_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT parent.id FROM public.datasheet_submissions parent JOIN public.datasheets sheet ON sheet.organization_id=parent.organization_id AND sheet.id=parent.datasheet_id
    JOIN public.test_requests job ON job.organization_id=sheet.organization_id AND job.id=sheet.test_request_id AND job.is_job
    JOIN public.test_requests child ON child.organization_id=job.organization_id AND child.parent_test_request_id=job.id AND child.id=request_id
    JOIN public.template_instances capture ON capture.organization_id=parent.organization_id AND capture.id=parent.instance_id
    WHERE parent.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
      AND parent.id=nullif(current_setting('app.job_submission_id',true),'')::uuid
      AND parent.submitted_by=nullif(current_setting('app.user_id',true),'')::uuid AND parent.xmin::text=pg_current_xact_id()::text
      AND parent.source_datasheet_id=parent.datasheet_id AND capture.status='frozen' AND capture.revision=parent.capture_revision
      AND public.app_has_permission('datasheets.execute')
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.approval_cases approval ON approval.organization_id=run.organization_id AND approval.workflow_run_id=run.id
        WHERE run.organization_id=child.organization_id AND run.test_request_id=child.id AND approval.status='pending')
$$;

CREATE FUNCTION laboratory_group_capture(capture_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public.datasheets sheet WHERE sheet.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND sheet.template_instance_id=capture_id AND sheet.status IN ('in_progress','rejected')
    AND public.laboratory_group_submission_for_request(sheet.test_request_id) IS NOT NULL)
$$;
GRANT EXECUTE ON FUNCTION laboratory_group_capture(uuid) TO sampleify_app;
CREATE POLICY group_submission_capture_freeze ON template_instances FOR UPDATE TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND laboratory_group_capture(id))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND status='frozen' AND laboratory_group_capture(id));

ALTER TABLE job_submission_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_submission_member_read ON job_submission_members FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT laboratory_can_read()));
CREATE POLICY job_submission_member_insert ON job_submission_members FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('datasheets.execute')));
GRANT SELECT,INSERT ON job_submission_members TO sampleify_app;
CREATE TRIGGER job_submission_member_append_only BEFORE UPDATE OR DELETE ON job_submission_members FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

CREATE FUNCTION laboratory_guard_job_submission_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.parent_submission_id IS DISTINCT FROM public.laboratory_group_submission_for_request(NEW.test_request_id)
    OR NOT EXISTS (SELECT 1 FROM public.datasheet_submissions submission JOIN public.datasheets sheet
      ON sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id AND sheet.latest_submission_id=submission.id
      JOIN public.test_requests request ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id AND request.final_datasheet_id=sheet.id
      WHERE submission.organization_id=NEW.organization_id AND submission.id=NEW.submission_id AND request.id=NEW.test_request_id
        AND sheet.status IN ('under_review','approved') AND request.status IN ('under_review','approved')) THEN
    RAISE EXCEPTION 'A job must cover the actual current submission of its child' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_submission_member_guard BEFORE INSERT ON job_submission_members FOR EACH ROW EXECUTE FUNCTION laboratory_guard_job_submission_member();

CREATE FUNCTION laboratory_complete_group_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job_id uuid;
BEGIN
  SELECT job.id INTO job_id FROM public.datasheets sheet JOIN public.test_requests job ON job.organization_id=sheet.organization_id AND job.id=sheet.test_request_id AND job.is_job
    WHERE sheet.organization_id=NEW.organization_id AND sheet.id=NEW.datasheet_id;
  IF job_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id=NEW.organization_id AND parent_test_request_id=job_id)
    OR EXISTS (SELECT 1 FROM public.test_requests child WHERE child.organization_id=NEW.organization_id AND child.parent_test_request_id=job_id
      AND NOT EXISTS (SELECT 1 FROM public.job_submission_members WHERE organization_id=NEW.organization_id AND parent_submission_id=NEW.id AND test_request_id=child.id))) THEN
    RAISE EXCEPTION 'Every job child needs an explicit submitted result in the same transaction' USING ERRCODE='23514';
  END IF;
  IF NEW.source='result_widget' AND NOT EXISTS (SELECT 1 FROM public.job_submission_members member JOIN public.datasheet_submissions parent
      ON parent.organization_id=member.organization_id AND parent.id=member.parent_submission_id
      WHERE member.organization_id=NEW.organization_id AND member.submission_id=NEW.id AND parent.datasheet_id=NEW.source_datasheet_id
        AND parent.instance_id=NEW.instance_id AND parent.capture_revision=NEW.capture_revision AND parent.submitted_by=NEW.submitted_by AND parent.submitted_at=NEW.submitted_at) THEN
    RAISE EXCEPTION 'A summary result must retain the actual frozen parent submission' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER group_submission_complete AFTER INSERT ON datasheet_submissions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_complete_group_submission();

-- New group access can freeze only captures actually submitted through that
-- group. This deferred check uses durable links, never a GUC cleared on success.
CREATE FUNCTION laboratory_complete_group_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status='frozen' AND OLD.status='editing' AND EXISTS (
    SELECT 1 FROM public.datasheets child_sheet JOIN public.test_requests child ON child.organization_id=child_sheet.organization_id AND child.id=child_sheet.test_request_id
      JOIN public.datasheets parent_sheet ON parent_sheet.organization_id=child.organization_id AND parent_sheet.test_request_id=child.parent_test_request_id
      JOIN public.datasheet_submissions parent ON parent.organization_id=parent_sheet.organization_id AND parent.datasheet_id=parent_sheet.id AND parent.xmin::text=pg_current_xact_id()::text
      WHERE child_sheet.organization_id=NEW.organization_id AND child_sheet.template_instance_id=NEW.id
        AND NOT EXISTS (SELECT 1 FROM public.job_submission_members member JOIN public.datasheet_submissions submission
          ON submission.organization_id=member.organization_id AND submission.id=member.submission_id
          WHERE member.organization_id=NEW.organization_id AND member.parent_submission_id=parent.id AND submission.instance_id=NEW.id AND submission.capture_revision=NEW.revision)
  ) THEN RAISE EXCEPTION 'A grouped capture freeze requires its actual covered submission' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER group_capture_complete AFTER UPDATE ON template_instances DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_complete_group_capture();

-- Forward replacements for exact grouped result provenance.

CREATE OR REPLACE FUNCTION laboratory_record_job_results(capture_id uuid, field_ids uuid[], occurrence_ids uuid[], positions integer[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  sheet public.datasheets; capture public.template_instances; selected public.template_values;
  subject public.datasheet_subjects; member_sheet uuid; item record; recorded integer:=0;
BEGIN
  IF capture_id IS DISTINCT FROM nullif(current_setting('app.capture_id',true),'')::uuid OR NOT public.laboratory_capture_can_write() THEN
    RAISE EXCEPTION 'Current assigned capture access required' USING ERRCODE='42501';
  END IF;
  SELECT source.* INTO sheet FROM public.datasheets source JOIN public.test_requests job ON job.organization_id=source.organization_id AND job.id=source.test_request_id AND job.is_job
    WHERE source.organization_id=org AND source.template_instance_id=capture_id;
  IF sheet.id IS NULL THEN RETURN 0; END IF;
  PERFORM public.laboratory_lock_job_members(sheet.id);
  SELECT * INTO capture FROM public.template_instances WHERE organization_id=org AND id=capture_id;
  IF EXISTS (SELECT 1 FROM public.template_sections WHERE organization_id=org AND version_id=capture.version_id AND is_final_result) THEN RETURN 0; END IF;
  IF cardinality(field_ids) IS NULL OR cardinality(field_ids) NOT BETWEEN 1 AND 1000
    OR cardinality(occurrence_ids) IS DISTINCT FROM cardinality(field_ids) OR cardinality(positions) IS DISTINCT FROM cardinality(field_ids)
    OR EXISTS (SELECT 1 FROM unnest(field_ids,occurrence_ids,positions) entry(field_id,occurrence_id,position)
      WHERE field_id IS NULL OR occurrence_id IS NULL OR position IS NULL OR position NOT BETWEEN 0 AND 999)
    OR (SELECT count(DISTINCT position) FROM unnest(positions) position)<>cardinality(positions) THEN
    RAISE EXCEPTION 'Result changes require distinct bounded input positions' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT * FROM unnest(field_ids,occurrence_ids,positions) entry(field_id,occurrence_id,position) ORDER BY position LOOP
    SELECT value.* INTO selected FROM public.template_values value JOIN public.template_fields field
      ON field.organization_id=value.organization_id AND field.version_id=value.version_id AND field.id=value.field_id AND field.widget='result_widget'
      WHERE value.organization_id=org AND value.instance_id=capture_id AND value.field_id=item.field_id AND value.occurrence_id=item.occurrence_id
        AND value.revision=capture.revision AND value.origin='entered' AND value.saved_by=actor AND value.xmin::text=pg_current_xact_id()::text;
    IF selected.field_id IS NULL THEN RAISE EXCEPTION 'Result history must reference an actual current input' USING ERRCODE='23514'; END IF;
    SELECT * INTO subject FROM public.datasheet_subjects WHERE organization_id=org
      AND id=public.laboratory_result_subject(org,capture_id,item.occurrence_id);
    IF subject.id IS NULL THEN CONTINUE; END IF;
    SELECT candidate.id INTO member_sheet FROM public.test_requests member JOIN public.datasheets candidate
      ON candidate.organization_id=member.organization_id AND candidate.test_request_id=member.id AND candidate.status<>'void'
      WHERE member.organization_id=org AND member.id=subject.test_request_id AND member.parent_test_request_id=sheet.test_request_id AND NOT member.is_job
      ORDER BY (candidate.id=member.final_datasheet_id) DESC NULLS LAST,candidate.attempt_number DESC,candidate.created_at DESC,candidate.id LIMIT 1;
    IF member_sheet IS NULL THEN RAISE EXCEPTION 'A linked test request needs an active datasheet' USING ERRCODE='23514'; END IF;
    INSERT INTO public.job_result_entries(organization_id,datasheet_id,child_datasheet_id,subject_id,instance_id,field_id,occurrence_id,value_revision,position,recorded_by)
      VALUES(org,sheet.id,member_sheet,subject.id,capture_id,item.field_id,item.occurrence_id,capture.revision,item.position,actor);
    recorded:=recorded+1;
  END LOOP;
  RETURN recorded;
END $$;

CREATE OR REPLACE FUNCTION laboratory_guard_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sheet public.datasheets; capture public.template_instances; selected public.template_values;
  field public.template_fields; unit public.measurement_units; specification public.analytical_specifications;
  scalar_text text; expected_number integer; current_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  SELECT * INTO sheet FROM public.datasheets WHERE organization_id=NEW.organization_id AND id=NEW.datasheet_id;
  NEW.source_datasheet_id:=coalesce(NEW.source_datasheet_id,NEW.datasheet_id);
  IF NEW.source<>'result_widget' THEN
    NEW.specification_id:=coalesce(NEW.specification_id,sheet.specification_id);
    IF NEW.specification_id IS DISTINCT FROM sheet.specification_id THEN RAISE EXCEPTION 'Own result must retain its datasheet specification' USING ERRCODE='23514'; END IF;
  ELSE
    IF public.laboratory_group_submission_for_request(sheet.test_request_id) IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.job_result_entries entry JOIN public.datasheet_subjects subject ON subject.organization_id=entry.organization_id AND subject.id=entry.subject_id
      WHERE entry.organization_id=NEW.organization_id AND entry.id=NEW.job_result_entry_id AND entry.datasheet_id=NEW.source_datasheet_id
        AND entry.child_datasheet_id=NEW.datasheet_id AND entry.instance_id=NEW.instance_id AND entry.field_id=NEW.field_id
        AND entry.occurrence_id=NEW.occurrence_id AND entry.value_revision=NEW.value_revision AND subject.specification_id=NEW.specification_id
        AND subject.test_request_id=sheet.test_request_id
        AND entry.id=(SELECT candidate.id FROM public.job_result_entries candidate JOIN public.datasheet_subjects bound
          ON bound.organization_id=candidate.organization_id AND bound.id=candidate.subject_id
          WHERE candidate.organization_id=entry.organization_id AND candidate.datasheet_id=entry.datasheet_id AND bound.test_request_id=subject.test_request_id
          AND candidate.value_revision<=NEW.capture_revision ORDER BY candidate.value_revision DESC,candidate.position DESC LIMIT 1)
    ) THEN RAISE EXCEPTION 'Grouped result must pin the actual latest summary input and its scientific subject' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id=NEW.organization_id AND id=NEW.instance_id;
  SELECT * INTO selected FROM public.template_values WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id
    AND field_id=NEW.field_id AND occurrence_id=NEW.occurrence_id AND revision<=NEW.capture_revision AND (NEW.source<>'result_widget' OR revision=NEW.value_revision) ORDER BY revision DESC LIMIT 1;
  SELECT * INTO field FROM public.template_fields WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=NEW.field_id;
  SELECT coalesce(max(number),0)+1 INTO expected_number FROM public.datasheet_submissions WHERE organization_id=NEW.organization_id AND datasheet_id=NEW.datasheet_id;
  IF sheet.id IS NULL OR capture.id IS NULL OR field.id IS NULL OR selected.field_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.datasheets source WHERE source.organization_id=NEW.organization_id AND source.id=NEW.source_datasheet_id AND source.template_instance_id=NEW.instance_id) OR capture.version_id IS DISTINCT FROM NEW.version_id
    OR capture.status<>'frozen' OR NEW.capture_revision<>capture.revision OR NEW.number<>expected_number
    OR selected.revision IS DISTINCT FROM NEW.value_revision OR selected.state NOT IN ('present','not_applicable')
    OR (NEW.source<>'result_widget' AND NOT EXISTS (SELECT 1 FROM public.template_occurrences WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id
      AND id=NEW.occurrence_id AND created_revision<=NEW.capture_revision AND (removed_revision IS NULL OR removed_revision>NEW.capture_revision))) THEN
    RAISE EXCEPTION 'Submission must pin the current frozen capture and its latest active value' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.template_columns column_detail JOIN public.template_rows row_detail
    ON row_detail.organization_id=column_detail.organization_id AND row_detail.version_id=column_detail.version_id AND row_detail.id=column_detail.row_id
    JOIN public.template_sections section ON section.organization_id=row_detail.organization_id AND section.version_id=row_detail.version_id AND section.id=row_detail.section_id
    WHERE column_detail.organization_id=NEW.organization_id AND column_detail.version_id=NEW.version_id AND column_detail.id=field.column_id
      AND ((NEW.source='result_widget' AND field.widget='result_widget') OR (NEW.source='column' AND column_detail.is_final_result) OR (NEW.source='section' AND section.is_final_result AND field.widget IN ('input_widget','formula_widget','result_widget')))) THEN
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
    SELECT * INTO specification FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=NEW.specification_id;
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
      OR (public.laboratory_group_submission_for_request(sheet.test_request_id) IS NULL AND NOT EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=NEW.organization_id AND test_request_id=sheet.test_request_id
        AND assignment_type='analyst' AND assigned_user_id=current_actor AND unassigned_at IS NULL))
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

CREATE OR REPLACE FUNCTION laboratory_submission_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests request
    ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id JOIN public.template_instances capture
    ON capture.organization_id=sheet.organization_id AND capture.id=NEW.instance_id
    WHERE sheet.organization_id=NEW.organization_id AND sheet.id=NEW.datasheet_id AND sheet.latest_submission_id=NEW.id
      AND sheet.status IN ('under_review','approved') AND sheet.completed_by=NEW.submitted_by AND sheet.completed_at=NEW.submitted_at
      AND request.final_datasheet_id=sheet.id AND request.status IN ('under_review','approved') AND capture.status='frozen' AND capture.revision=NEW.capture_revision
      AND EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=sheet.organization_id AND event.test_request_id=request.id
        AND event.event_type='datasheet_submitted' AND event.actor_user_id=NEW.submitted_by AND event.xmin::text=pg_current_xact_id()::text)) THEN
    RAISE EXCEPTION 'Submission, frozen capture, owner status and actual audit event must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION workflow_test_request_submission(request_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT submission.id FROM public.test_requests request JOIN public.datasheets sheet
    ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id AND sheet.id=request.final_datasheet_id
    JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.datasheet_id=sheet.id AND submission.id=sheet.latest_submission_id
    JOIN public.template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=submission.instance_id
    WHERE request.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND request.id=request_id AND public.laboratory_can_read()
      AND request.status IN ('under_review','approved') AND sheet.status IN ('under_review','approved') AND capture.status='frozen' AND capture.revision=submission.capture_revision
      AND EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=request.organization_id AND test_request_id=request.id AND assignment_type='analyst' AND unassigned_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION workflow_guard_result_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE run public.workflow_runs;
BEGIN
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=NEW.organization_id AND id=NEW.workflow_run_id;
  IF NEW.datasheet_submission_id IS NOT NULL AND (run.test_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.datasheet_submissions submission JOIN public.datasheets sheet
    ON sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id WHERE submission.organization_id=NEW.organization_id
      AND submission.id=NEW.datasheet_submission_id AND sheet.test_request_id=run.test_request_id)) THEN
    RAISE EXCEPTION 'Workflow result evidence must belong to its test request' USING ERRCODE='23514';
  END IF;
  IF session_user='sampleify_app' AND run.test_request_id IS NOT NULL AND NEW.action IN ('requested','transitioned','approved','completed','cancelled')
    AND (NEW.datasheet_submission_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.test_requests request JOIN public.datasheets sheet
      ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id AND sheet.test_request_id=request.id
      JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.id=sheet.latest_submission_id
      JOIN public.template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=submission.instance_id
      WHERE request.organization_id=NEW.organization_id AND request.id=run.test_request_id AND submission.id=NEW.datasheet_submission_id
        AND capture.status='frozen' AND capture.revision=submission.capture_revision)) THEN
    RAISE EXCEPTION 'A transition must retain its actual frozen submitted result' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION report_guard_item() RETURNS trigger
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
