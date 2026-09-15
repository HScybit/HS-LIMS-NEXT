-- Skip value comparisons only when no captured definition requires uniqueness.
CREATE OR REPLACE FUNCTION masters_assert_product_custom_field_uniqueness(target_organization uuid,target_product uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.product_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=target_organization AND field.product_id=target_product AND field.revision=target_revision
      AND definition.validate_uniqueness
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.product_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.product_version_custom_field_values value ON value.organization_id=field.organization_id AND value.product_id=field.product_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.product_id=target_product AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='product_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.product_version_custom_field_values value ON value.organization_id=field.organization_id AND value.product_id=field.product_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.product_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.products product ON product.organization_id=existing.organization_id AND product.id=existing.product_id AND product.revision=existing.revision AND product.active
    WHERE field.organization_id=target_organization AND field.product_id=target_product AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.product_id<>target_product
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='product_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_assert_parameter_custom_field_uniqueness(target_organization uuid,target_parameter uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.parameter_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision
      AND definition.validate_uniqueness
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.parameter_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.parameter_version_custom_field_values value ON value.organization_id=field.organization_id AND value.parameter_id=field.parameter_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.parameter_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.parameter_version_custom_field_values value ON value.organization_id=field.organization_id AND value.parameter_id=field.parameter_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.parameter_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.test_parameters parameter ON parameter.organization_id=existing.organization_id AND parameter.id=existing.parameter_id AND parameter.revision=existing.revision AND parameter.active
    WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.parameter_id<>target_parameter
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_unique'; END IF;
END $$;
