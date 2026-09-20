CREATE OR REPLACE FUNCTION users_assert_custom_field_uniqueness(target_organization uuid,target_user uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- Decide from the pinned field headers before normalizing or scanning any value rows.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user
      AND field.revision=target_revision AND definition.validate_uniqueness
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
  IF EXISTS (
    -- Normalize each bounded incoming item once before joining historical definitions and values.
    WITH incoming AS MATERIALIZED (
      SELECT definition.key,
        public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text
      FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
        AND value.revision=field.revision AND value.field_id=field.field_id
      WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision AND definition.validate_uniqueness
    )
    SELECT 1 FROM incoming
    JOIN public.custom_field_versions saved_definition ON saved_definition.organization_id=target_organization AND saved_definition.key=incoming.key
    JOIN public.user_version_custom_fields saved_field ON saved_field.organization_id=saved_definition.organization_id
      AND saved_field.field_id=saved_definition.field_id AND saved_field.field_revision=saved_definition.revision
    JOIN public.memberships member ON member.organization_id=saved_field.organization_id AND member.user_id=saved_field.subject_user_id
      AND member.custom_field_revision=saved_field.revision
    JOIN public.user_version_custom_field_values existing ON existing.organization_id=saved_field.organization_id AND existing.subject_user_id=saved_field.subject_user_id
      AND existing.revision=saved_field.revision AND existing.field_id=saved_field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    WHERE incoming.text IS NOT NULL AND existing.subject_user_id<>target_user
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
END $$;
