ALTER TABLE job_result_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_result_entry_read ON job_result_entries FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT laboratory_can_read()));
GRANT SELECT ON job_result_entries TO sampleify_app;
CREATE TRIGGER job_result_entry_append_only BEFORE UPDATE OR DELETE ON job_result_entries
  FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

-- The nearest bound ancestor supplies nested measurements' stable subject.
CREATE FUNCTION laboratory_result_subject(org uuid, capture_id uuid, occurrence_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,0 AS depth FROM public.template_occurrences WHERE organization_id=org AND instance_id=capture_id AND id=occurrence_id
    UNION ALL SELECT parent.id,parent.parent_id,ancestor.depth+1 FROM ancestors ancestor JOIN public.template_occurrences parent
      ON parent.organization_id=org AND parent.instance_id=capture_id AND parent.id=ancestor.parent_id
  ) SELECT subject.id FROM ancestors ancestor JOIN public.datasheet_subjects subject
    ON subject.organization_id=org AND subject.instance_id=capture_id AND subject.occurrence_id=ancestor.id
    ORDER BY ancestor.depth LIMIT 1
$$;

-- The capture command has already inserted the values. Record their actual
-- input order and the currently selected child method without editing the
-- child's capture, assignment, submission or workflow.
CREATE FUNCTION laboratory_record_job_results(capture_id uuid, field_ids uuid[], occurrence_ids uuid[], positions integer[]) RETURNS integer
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
    INSERT INTO public.job_result_entries(organization_id,datasheet_id,child_datasheet_id,subject_id,instance_id,field_id,occurrence_id,value_revision,position)
      VALUES(org,sheet.id,member_sheet,subject.id,capture_id,item.field_id,item.occurrence_id,capture.revision,item.position);
    recorded:=recorded+1;
  END LOOP;
  RETURN recorded;
END $$;
GRANT EXECUTE ON FUNCTION laboratory_record_job_results(uuid,uuid[],uuid[],integer[]) TO sampleify_app;

-- Inputs on existing occurrences must commit with their child provenance.
-- Initial/default and newly cloned occurrence values do not select a new result.
CREATE FUNCTION laboratory_complete_job_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND NEW.origin='entered'
    AND EXISTS (SELECT 1 FROM public.template_occurrences WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND id=NEW.occurrence_id AND created_revision<NEW.revision)
    AND EXISTS (SELECT 1 FROM public.template_fields WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=NEW.field_id AND widget='result_widget')
    AND EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests job ON job.organization_id=sheet.organization_id AND job.id=sheet.test_request_id AND job.is_job
      WHERE sheet.organization_id=NEW.organization_id AND sheet.template_instance_id=NEW.instance_id)
    AND NOT EXISTS (SELECT 1 FROM public.template_sections WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND is_final_result)
    AND public.laboratory_result_subject(NEW.organization_id,NEW.instance_id,NEW.occurrence_id) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.job_result_entries WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id
      AND field_id=NEW.field_id AND occurrence_id=NEW.occurrence_id AND value_revision=NEW.revision) THEN
    RAISE EXCEPTION 'A changed job result and its actual child provenance must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER job_result_value_complete AFTER INSERT ON template_values DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_complete_job_result();

CREATE FUNCTION laboratory_guard_result_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE config public.template_numeric_config;
BEGIN
  IF NEW.origin<>'entered' OR NEW.state<>'present' OR NOT EXISTS (SELECT 1 FROM public.template_fields
    WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=NEW.field_id AND widget='result_widget') THEN RETURN NEW; END IF;
  SELECT * INTO config FROM public.template_numeric_config WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND field_id=NEW.field_id;
  IF NEW.lexical IS NULL OR NEW.lexical !~ '^-?[0-9]+([.][0-9]+)?$'
    OR NEW.number_value<>NEW.lexical::numeric OR NEW.number_value<>round(NEW.number_value,2)
    OR length(ltrim(split_part(NEW.lexical,'.',1),'-0'))>18 OR length(split_part(NEW.lexical,'.',2))>12
    OR NEW.number_value::float8::text::numeric<>NEW.number_value
    OR (config.display_scale IS NOT NULL AND length(split_part(NEW.lexical,'.',2))>config.display_scale)
    OR (config.minimum IS NOT NULL AND NEW.number_value<config.minimum) OR (config.maximum IS NOT NULL AND NEW.number_value>config.maximum) THEN
    RAISE EXCEPTION 'Scientific result interpretation is unresolved' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER result_number_guard BEFORE INSERT ON template_values FOR EACH ROW EXECUTE FUNCTION laboratory_guard_result_number();
