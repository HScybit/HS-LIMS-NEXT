CREATE OR REPLACE FUNCTION users_assert_custom_field_uniqueness(target_organization uuid,target_user uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- Keep primary-key lookups parameterized even before a new organization's statistics are collected.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_version_custom_fields field JOIN LATERAL (
      SELECT 1 FROM public.custom_field_versions definition
      WHERE definition.organization_id=field.organization_id AND definition.field_id=field.field_id
        AND definition.revision=field.field_revision AND definition.validate_uniqueness LIMIT 1
    ) definition ON true
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.user_version_custom_fields field JOIN LATERAL (
      SELECT 1 FROM public.custom_field_versions definition
      WHERE definition.organization_id=field.organization_id AND definition.field_id=field.field_id
        AND definition.revision=field.field_revision AND definition.validate_uniqueness LIMIT 1
    ) definition ON true
    JOIN LATERAL (
      SELECT raw_kind,raw_text,raw_number,raw_boolean,raw_number_text FROM public.user_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
        AND value.revision=field.revision AND value.field_id=field.field_id OFFSET 0
    ) value ON true
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
  IF EXISTS (
    -- Normalize each bounded incoming item once before probing all historical definitions with its saved key.
    WITH incoming AS MATERIALIZED (
      SELECT definition.key,
        public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text
      FROM public.user_version_custom_fields field JOIN LATERAL (
        SELECT key FROM public.custom_field_versions definition
        WHERE definition.organization_id=field.organization_id AND definition.field_id=field.field_id
          AND definition.revision=field.field_revision AND definition.validate_uniqueness LIMIT 1
      ) definition ON true
      JOIN LATERAL (
        SELECT raw_kind,raw_text,raw_number,raw_boolean,raw_number_text FROM public.user_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
          AND value.revision=field.revision AND value.field_id=field.field_id OFFSET 0
      ) value ON true
      WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision
    )
    SELECT 1 FROM incoming JOIN LATERAL (
      SELECT field_id,revision FROM public.custom_field_versions saved_definition
      WHERE saved_definition.organization_id=target_organization AND saved_definition.key=incoming.key OFFSET 0
    ) saved_definition ON true
    JOIN LATERAL (
      SELECT subject_user_id,revision FROM public.user_version_custom_field_values existing
      WHERE existing.organization_id=target_organization AND existing.field_id=saved_definition.field_id
        AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
        AND existing.subject_user_id<>target_user OFFSET 0
    ) existing ON true
    JOIN LATERAL (
      SELECT 1 FROM public.user_version_custom_fields saved_field
      WHERE saved_field.organization_id=target_organization AND saved_field.field_id=saved_definition.field_id
        AND saved_field.subject_user_id=existing.subject_user_id AND saved_field.revision=existing.revision
        AND saved_field.field_revision=saved_definition.revision LIMIT 1
    ) saved_field ON true
    JOIN LATERAL (
      SELECT 1 FROM public.memberships member
      WHERE member.organization_id=target_organization AND member.user_id=existing.subject_user_id
        AND member.custom_field_revision=existing.revision LIMIT 1
    ) member ON true
    WHERE incoming.text IS NOT NULL
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
END $$;
