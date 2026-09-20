-- TR Data reads its request context. Title, Required and Default Value remain
-- template configuration and cannot create new captured-value history.
CREATE FUNCTION template_guard_tr_data_value() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_fields field WHERE field.organization_id=NEW.organization_id
    AND field.version_id=NEW.version_id AND field.id=NEW.field_id AND field.widget='tr_data_widget') THEN
    RAISE EXCEPTION 'TR Data cannot accept captured values' USING ERRCODE='23514',CONSTRAINT='tr_data_readonly';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_tr_data_value_guard BEFORE INSERT ON template_values FOR EACH ROW EXECUTE FUNCTION template_guard_tr_data_value();
REVOKE ALL ON FUNCTION template_guard_tr_data_value() FROM PUBLIC,sampleify_app,sampleify_report_worker;

--> statement-breakpoint
-- Validate each inserted batch together. The existing per-row guards still
-- enforce actors, revision ownership, read-only widgets and typed references.
CREATE FUNCTION template_guard_inserted_values() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE scope record; capture public.template_instances;
  invalid_occurrence boolean; invalid_formula boolean; invalid_image boolean; invalid_default boolean;
BEGIN
  FOR scope IN SELECT organization_id,instance_id FROM inserted_values
    GROUP BY organization_id,instance_id ORDER BY organization_id,instance_id LOOP
    SELECT * INTO capture FROM public.template_instances
      WHERE organization_id=scope.organization_id AND id=scope.instance_id FOR UPDATE;
    IF capture.status IS DISTINCT FROM 'editing' OR EXISTS (
      SELECT 1 FROM inserted_values value WHERE value.organization_id=scope.organization_id AND value.instance_id=scope.instance_id
        AND (value.version_id<>capture.version_id OR value.revision<>capture.revision)
    ) THEN
      RAISE EXCEPTION 'Value must use the editable capture version and current revision' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT bool_or(occurrence.id IS NULL OR field.id IS NULL OR occurrence.removed_revision IS NOT NULL
      OR field.repeat_group_id IS DISTINCT FROM occurrence.group_id),
    bool_or((field.widget='formula_widget') IS DISTINCT FROM (value.origin='calculated')),
    bool_or(field.widget='template_image_widget' AND value.origin<>'default'),
    bool_or(value.origin='default' AND (field.default_state='absent' OR occurrence.created_revision<>value.revision
      OR (value.state,value.number_value,value.text_value,value.boolean_value,value.date_value,value.option_id,value.image_id,value.lexical,value.error_code,value.error_message)
        IS DISTINCT FROM (field.default_state,field.default_number,field.default_text,field.default_boolean,field.default_date,NULL::uuid,field.default_image_id,field.default_lexical,NULL::text,NULL::text)))
    INTO invalid_occurrence,invalid_formula,invalid_image,invalid_default
    FROM inserted_values value
    LEFT JOIN LATERAL (
      SELECT id,group_id,removed_revision,created_revision FROM public.template_occurrences occurrence
      WHERE occurrence.organization_id=value.organization_id AND occurrence.instance_id=value.instance_id
        AND occurrence.version_id=value.version_id AND occurrence.id=value.occurrence_id LIMIT 1
    ) occurrence ON true
    LEFT JOIN LATERAL (
      SELECT id,repeat_group_id,widget,default_state,default_number,default_text,default_boolean,default_date,default_image_id,default_lexical
      FROM public.template_fields field WHERE field.organization_id=value.organization_id
        AND field.version_id=value.version_id AND field.id=value.field_id LIMIT 1
    ) field ON true;
  IF invalid_occurrence THEN RAISE EXCEPTION 'Value field and repeat occurrence do not match' USING ERRCODE='23514'; END IF;
  IF invalid_formula THEN RAISE EXCEPTION 'Calculated fields cannot accept entered values' USING ERRCODE='23514'; END IF;
  IF invalid_image THEN RAISE EXCEPTION 'Template images are frozen defaults' USING ERRCODE='23514'; END IF;
  IF invalid_default THEN RAISE EXCEPTION 'Default history must match its frozen field and new occurrence' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION template_guard_inserted_values() FROM PUBLIC,sampleify_app,sampleify_report_worker;
DROP TRIGGER template_value_guard ON template_values;
CREATE TRIGGER template_value_guard BEFORE UPDATE OR DELETE ON template_values
  FOR EACH ROW EXECUTE FUNCTION template_guard_value();
CREATE TRIGGER template_inserted_values_guard AFTER INSERT ON template_values
  REFERENCING NEW TABLE AS inserted_values FOR EACH STATEMENT EXECUTE FUNCTION template_guard_inserted_values();
