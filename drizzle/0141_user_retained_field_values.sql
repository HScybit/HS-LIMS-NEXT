CREATE OR REPLACE FUNCTION users_guard_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.user_field_value_versions; field public.user_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[]; current_field_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'User Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.user_field_value_versions WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=NEW.revision;
  IF version.subject_user_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=NEW.organization_id AND user_id=NEW.subject_user_id AND custom_field_revision=NEW.revision) THEN
    RAISE EXCEPTION 'User Custom Fields require their actual new version transaction' USING ERRCODE='23514',CONSTRAINT='user_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='user_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'User Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'User Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='user_custom_field_type';
    END IF;
    IF NEW.field_type IN ('date','date_time') AND NEW.time_zone IS DISTINCT FROM version.time_zone THEN
      RAISE EXCEPTION 'Date fields require their capture time zone' USING ERRCODE='23514',CONSTRAINT='user_custom_field_timezone';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='users' AND active
    ) THEN RAISE EXCEPTION 'Select the current User Custom Field revision' USING ERRCODE='23514',CONSTRAINT='user_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.user_version_custom_fields
      WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'User Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='user_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated User Custom Field items' USING ERRCODE='23514';
    END IF;
    NEW.user_username:=NULL; NEW.user_name:=NULL;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id);
    IF version.previous_revision>0 AND (
      field.field_type='select' AND (NEW.interpretation_state='invalid' OR NEW.interpretation_state='valid' AND NEW.option_revision<>field.field_revision)
      OR field.field_type='attachment' AND NEW.interpretation_state='valid'
    ) THEN
      -- Bound retained-item checks by saved-key field IDs before inspecting potentially thousands of prior items.
      SELECT key INTO current_field_key FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=current_field_key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          -- Each captured field has one primary-key row; keep this lookup parameterized in cached plans.
          SELECT field_id FROM public.user_version_custom_fields
            WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    END IF;
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
          IF NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.user_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous User revision' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='user_custom_value_user';
          END IF;
          SELECT person.username,person.display_name INTO NEW.user_username,NEW.user_name
            FROM public.memberships member JOIN public.users person ON person.id=member.user_id
            WHERE member.organization_id=NEW.organization_id AND member.user_id=NEW.user_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'Select users in this organization' USING ERRCODE='23514',CONSTRAINT='user_custom_value_user'; END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id AND uploaded_definition.revision=attachment.field_revision
              WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
                AND (attachment.field_id=NEW.field_id OR EXISTS (
                  SELECT 1 FROM public.user_version_custom_field_values previous
                  WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
                    AND previous.field_id=ANY(previous_field_ids)
                    AND previous.attachment_id=NEW.attachment_id
                ))
                AND uploaded_definition.associated_with='users' AND uploaded_definition.field_type='attachment'
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='user_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN RAISE EXCEPTION 'This lookup has no configured source' USING ERRCODE='23514',CONSTRAINT='user_custom_value_lookup';
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Preserve an unresolved previous raw value by saved key, without inventing a cross-definition option reference.
      IF EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      ) OR NOT EXISTS (
        SELECT 1 FROM public.user_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
          AND previous.field_id=ANY(previous_field_ids)
          AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
          AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
            IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
