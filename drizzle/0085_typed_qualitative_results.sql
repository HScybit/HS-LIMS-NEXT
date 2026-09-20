ALTER TABLE "template_fields" DROP CONSTRAINT "template_widget_type";--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_field_default";--> statement-breakpoint
ALTER TABLE "template_numeric_config" DROP CONSTRAINT "numeric_config_type";--> statement-breakpoint
ALTER TABLE "template_values" DROP CONSTRAINT "template_value_payload";--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'result_widget' and "template_fields"."value_type" in ('numeric', 'result')) or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option'));--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_field_default" CHECK (("template_fields"."default_state" in ('absent', 'empty') and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date") = 0) or ("template_fields"."default_state" = 'present' and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date") = 1 and (("template_fields"."value_type" in ('text', 'result') and "template_fields"."default_text" is not null) or ("template_fields"."value_type" in ('numeric', 'result') and "template_fields"."default_number" is not null and "template_fields"."default_number"::text not in ('NaN', 'Infinity', '-Infinity')) or ("template_fields"."value_type" = 'boolean' and "template_fields"."default_boolean" is not null) or ("template_fields"."value_type" = 'date' and "template_fields"."default_date" is not null))));--> statement-breakpoint
ALTER TABLE "template_numeric_config" ADD CONSTRAINT "numeric_config_type" CHECK ("template_numeric_config"."value_type" in ('numeric', 'result') and ("template_numeric_config"."display_scale" is null or "template_numeric_config"."display_scale" between 0 and 100) and ("template_numeric_config"."minimum" is null or "template_numeric_config"."maximum" is null or "template_numeric_config"."minimum" <= "template_numeric_config"."maximum") and coalesce("template_numeric_config"."minimum"::text, '') not in ('NaN', 'Infinity', '-Infinity') and coalesce("template_numeric_config"."maximum"::text, '') not in ('NaN', 'Infinity', '-Infinity'));--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_payload" CHECK ((
    ("template_values"."state" in ('absent', 'empty', 'not_applicable', 'invalid') and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id") = 0) or
    ("template_values"."state" = 'present' and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id") = 1 and (
      ("template_values"."value_type" in ('numeric', 'result') and "template_values"."number_value" is not null and "template_values"."number_value"::text not in ('NaN', 'Infinity', '-Infinity')) or
      ("template_values"."value_type" in ('text', 'result') and "template_values"."text_value" is not null) or ("template_values"."value_type" = 'boolean' and "template_values"."boolean_value" is not null) or
      ("template_values"."value_type" = 'date' and "template_values"."date_value" is not null) or ("template_values"."value_type" = 'option' and "template_values"."option_id" is not null)
    ))) and (("template_values"."state" = 'invalid' and "template_values"."error_code" is not null and "template_values"."error_message" is not null) or ("template_values"."state" <> 'invalid' and "template_values"."error_code" is null and "template_values"."error_message" is null)));
--> statement-breakpoint

-- The result contract permits exactly one numeric or qualitative payload. Old
-- numeric contracts and all previously frozen values remain unchanged.
CREATE OR REPLACE FUNCTION laboratory_guard_result_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE config public.template_numeric_config;
BEGIN
  IF NEW.origin<>'entered' OR NEW.state<>'present' OR NOT EXISTS (SELECT 1 FROM public.template_fields
    WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=NEW.field_id AND widget='result_widget') THEN RETURN NEW; END IF;
  IF NEW.value_type='result' AND NEW.text_value IS NOT NULL THEN
    IF length(NEW.text_value) NOT BETWEEN 1 AND 16000 OR NEW.lexical IS NOT NULL
      OR NEW.text_value<>btrim(NEW.text_value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      OR NEW.text_value ~ '^[+-]?([0-9]|[.][0-9]|Infinity)' THEN
      RAISE EXCEPTION 'Scientific result interpretation is unresolved' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Validate lexical shape and bounds before casts. No rounding or numeric
  -- prefixes are chosen while the source numeric-policy decision is pending.
  IF NEW.number_value IS NULL OR NEW.lexical IS NULL OR length(NEW.lexical)>1000 OR NEW.lexical !~ '^-?[0-9]+([.][0-9]+)?$'
    OR length(ltrim(split_part(NEW.lexical,'.',1),'-0'))>18 OR length(split_part(NEW.lexical,'.',2))>12 THEN
    RAISE EXCEPTION 'Scientific result interpretation is unresolved' USING ERRCODE='23514';
  END IF;
  SELECT * INTO config FROM public.template_numeric_config WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND field_id=NEW.field_id;
  IF NEW.number_value<>NEW.lexical::numeric OR NEW.number_value<>round(NEW.number_value,2)
    OR NEW.number_value::float8::text::numeric<>NEW.number_value
    OR (config.display_scale IS NOT NULL AND length(split_part(NEW.lexical,'.',2))>config.display_scale)
    OR (config.minimum IS NOT NULL AND NEW.number_value<config.minimum) OR (config.maximum IS NOT NULL AND NEW.number_value>config.maximum) THEN
    RAISE EXCEPTION 'Scientific result interpretation is unresolved' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
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
  ELSIF selected.value_type IN ('text','result') AND selected.text_value IS NOT NULL THEN scalar_text := selected.text_value;
  ELSIF selected.value_type='date' THEN scalar_text := selected.date_value::text;
  ELSIF selected.value_type='option' THEN
    SELECT value INTO scalar_text FROM public.template_options WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND field_id=NEW.field_id AND id=selected.option_id;
  END IF;
  IF selected.state='present' AND selected.value_type='boolean' THEN
    IF NEW.result_type<>'boolean' OR NEW.boolean_value IS DISTINCT FROM selected.boolean_value THEN RAISE EXCEPTION 'Submitted boolean differs from recorded value' USING ERRCODE='23514'; END IF;
  ELSIF selected.state='present' AND selected.value_type IN ('numeric','result') AND selected.number_value IS NOT NULL THEN
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
