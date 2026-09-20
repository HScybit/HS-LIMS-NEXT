-- All three master captures recognize the actual Method legacy association.
-- Private User uploads and immutable upload-key provenance keep their existing boundaries.
CREATE OR REPLACE FUNCTION masters_guard_product_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.product_versions; field public.product_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Product Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.product_versions WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.revision;
  IF version.product_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.products WHERE organization_id=NEW.organization_id AND id=NEW.product_id
        AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
    RAISE EXCEPTION 'Product Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='product_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='product_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Product Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Product Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='product_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='product' AND active
    ) THEN RAISE EXCEPTION 'Select the current Product Custom Field revision' USING ERRCODE='23514',CONSTRAINT='product_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.product_version_custom_fields
      WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Product Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='product_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Product Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.product_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
      END IF;
    ELSIF field.field_type='select' AND version.previous_revision>0 AND (
      NEW.interpretation_state='invalid' OR version.custom_fields_provided AND NEW.option_revision<>field.field_revision
    ) THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      -- Restrict prior items to the same saved key before checking their raw values.
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          SELECT field_id FROM public.product_version_custom_fields
            WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    ELSIF field.field_type='attachment' AND NEW.interpretation_state='valid' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF version.previous_revision>0 THEN
        WITH key_definitions AS MATERIALIZED (
          SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
        ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
          FROM key_definitions previous_definition JOIN LATERAL (
            SELECT field_id FROM public.product_version_custom_fields
              WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=version.previous_revision
                AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
          ) previous_field ON true;
      END IF;
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id,NEW.lookup_source_id,NEW.lookup_revision,NEW.lookup_line_id);
    IF NEW.interpretation_state='valid' THEN
      CASE field.field_type
        WHEN 'number' THEN
          IF NEW.parsed_number IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A numeric field requires its typed numeric interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'checkbox' THEN
          IF NEW.parsed_boolean IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A checkbox requires its typed boolean interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'date' THEN
          IF NEW.parsed_date IS NULL OR NEW.parsed_timestamp IS NULL OR related_count<>2 THEN RAISE EXCEPTION 'A date requires its local date and parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'date_time' THEN
          IF NEW.parsed_timestamp IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A date-time field requires its parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'select' THEN
          IF NEW.option_id IS NULL OR NEW.option_revision IS NULL OR related_count<>2 OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
              AND option.field_id=NEW.field_id AND option.revision=NEW.option_revision AND option.id=NEW.option_id
              AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='product_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.product_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Product revision' USING ERRCODE='23514',CONSTRAINT='product_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='product_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with IN ('product','parameter','method_of_analysis') AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.product_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='product_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN
          IF NEW.lookup_source_id IS NULL OR NEW.lookup_revision IS NULL OR NEW.lookup_line_id IS NULL OR related_count<>3
            OR definition.lookup_source_id IS DISTINCT FROM NEW.lookup_source_id
            OR NEW.lookup_line_id IS DISTINCT FROM (CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END)
            OR NOT EXISTS (
              SELECT 1 FROM public.custom_field_lookup_lines line
              WHERE line.organization_id=NEW.organization_id AND line.source_id=NEW.lookup_source_id
                AND line.revision=NEW.lookup_revision AND line.original_line_id=NEW.lookup_line_id
                AND (NOT version.custom_fields_provided OR EXISTS (
                  SELECT 1 FROM public.custom_field_lookup_sources source
                    WHERE source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
                ))
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='product_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Keep an unavailable saved value without claiming a foreign definition's option.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.product_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='product_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.product_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='product_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_guard_parameter_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions; field public.parameter_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Parameter Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.test_parameter_versions WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision;
  IF version.parameter_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.test_parameters WHERE organization_id=NEW.organization_id AND id=NEW.parameter_id
        AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
    RAISE EXCEPTION 'Parameter Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='parameter_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Parameter Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Parameter Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='parameter' AND active
    ) THEN RAISE EXCEPTION 'Select the current Parameter Custom Field revision' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.parameter_version_custom_fields
      WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Parameter Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Parameter Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.parameter_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
      END IF;
    ELSIF field.field_type='select' AND version.previous_revision>0 AND (
      NEW.interpretation_state='invalid' OR version.custom_fields_provided AND NEW.option_revision<>field.field_revision
    ) THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      -- Restrict prior items to the same saved key before checking their raw values.
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          SELECT field_id FROM public.parameter_version_custom_fields
            WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    ELSIF field.field_type='attachment' AND NEW.interpretation_state='valid' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF version.previous_revision>0 THEN
        WITH key_definitions AS MATERIALIZED (
          SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
        ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
          FROM key_definitions previous_definition JOIN LATERAL (
            SELECT field_id FROM public.parameter_version_custom_fields
              WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=version.previous_revision
                AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
          ) previous_field ON true;
      END IF;
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id,NEW.lookup_source_id,NEW.lookup_revision,NEW.lookup_line_id);
    IF NEW.interpretation_state='valid' THEN
      CASE field.field_type
        WHEN 'number' THEN
          IF NEW.parsed_number IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A numeric field requires its typed numeric interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'checkbox' THEN
          IF NEW.parsed_boolean IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A checkbox requires its typed boolean interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'date' THEN
          IF NEW.parsed_date IS NULL OR NEW.parsed_timestamp IS NULL OR related_count<>2 THEN RAISE EXCEPTION 'A date requires its local date and parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'date_time' THEN
          IF NEW.parsed_timestamp IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A date-time field requires its parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'select' THEN
          IF NEW.option_id IS NULL OR NEW.option_revision IS NULL OR related_count<>2 OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
              AND option.field_id=NEW.field_id AND option.revision=NEW.option_revision AND option.id=NEW.option_id
              AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.parameter_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Parameter revision' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with IN ('product','parameter','method_of_analysis') AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.parameter_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN
          IF NEW.lookup_source_id IS NULL OR NEW.lookup_revision IS NULL OR NEW.lookup_line_id IS NULL OR related_count<>3
            OR definition.lookup_source_id IS DISTINCT FROM NEW.lookup_source_id
            OR NEW.lookup_line_id IS DISTINCT FROM (CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END)
            OR NOT EXISTS (
              SELECT 1 FROM public.custom_field_lookup_lines line
              WHERE line.organization_id=NEW.organization_id AND line.source_id=NEW.lookup_source_id
                AND line.revision=NEW.lookup_revision AND line.original_line_id=NEW.lookup_line_id
                AND (NOT version.custom_fields_provided OR EXISTS (
                  SELECT 1 FROM public.custom_field_lookup_sources source
                    WHERE source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
                ))
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Keep an unavailable saved value without claiming a foreign definition's option.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.parameter_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.parameter_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_guard_method_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.method_versions; field public.method_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Method Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.method_versions WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision;
  IF version.method_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.methods_of_analysis WHERE organization_id=NEW.organization_id AND id=NEW.method_id
        AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
    RAISE EXCEPTION 'Method Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='method_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='method_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Method Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Method Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='method_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='method_of_analysis' AND active
    ) THEN RAISE EXCEPTION 'Select the current Method Custom Field revision' USING ERRCODE='23514',CONSTRAINT='method_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.method_version_custom_fields
      WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Method Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='method_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Method Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.method_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
      END IF;
    ELSIF field.field_type='select' AND version.previous_revision>0 AND (
      NEW.interpretation_state='invalid' OR version.custom_fields_provided AND NEW.option_revision<>field.field_revision
    ) THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      -- Restrict prior items to the same saved key before checking their raw values.
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          SELECT field_id FROM public.method_version_custom_fields
            WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    ELSIF field.field_type='attachment' AND NEW.interpretation_state='valid' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF version.previous_revision>0 THEN
        WITH key_definitions AS MATERIALIZED (
          SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
        ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
          FROM key_definitions previous_definition JOIN LATERAL (
            SELECT field_id FROM public.method_version_custom_fields
              WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=version.previous_revision
                AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
          ) previous_field ON true;
      END IF;
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id,NEW.lookup_source_id,NEW.lookup_revision,NEW.lookup_line_id);
    IF NEW.interpretation_state='valid' THEN
      CASE field.field_type
        WHEN 'number' THEN
          IF NEW.parsed_number IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A numeric field requires its typed numeric interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'checkbox' THEN
          IF NEW.parsed_boolean IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A checkbox requires its typed boolean interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'date' THEN
          IF NEW.parsed_date IS NULL OR NEW.parsed_timestamp IS NULL OR related_count<>2 THEN RAISE EXCEPTION 'A date requires its local date and parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'date_time' THEN
          IF NEW.parsed_timestamp IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A date-time field requires its parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'select' THEN
          IF NEW.option_id IS NULL OR NEW.option_revision IS NULL OR related_count<>2 OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
              AND option.field_id=NEW.field_id AND option.revision=NEW.option_revision AND option.id=NEW.option_id
              AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='method_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.method_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Method revision' USING ERRCODE='23514',CONSTRAINT='method_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='method_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with IN ('product','parameter','method_of_analysis') AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.method_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='method_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN
          IF NEW.lookup_source_id IS NULL OR NEW.lookup_revision IS NULL OR NEW.lookup_line_id IS NULL OR related_count<>3
            OR definition.lookup_source_id IS DISTINCT FROM NEW.lookup_source_id
            OR NEW.lookup_line_id IS DISTINCT FROM (CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END)
            OR NOT EXISTS (
              SELECT 1 FROM public.custom_field_lookup_lines line
              WHERE line.organization_id=NEW.organization_id AND line.source_id=NEW.lookup_source_id
                AND line.revision=NEW.lookup_revision AND line.original_line_id=NEW.lookup_line_id
                AND (NOT version.custom_fields_provided OR EXISTS (
                  SELECT 1 FROM public.custom_field_lookup_sources source
                    WHERE source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
                ))
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='method_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Keep an unavailable saved value without claiming a foreign definition's option.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.method_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='method_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.method_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='method_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
