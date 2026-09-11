-- FOR SHARE applies UPDATE RLS policies too. Registrars may lock selected
-- scientific references without receiving master-write permission.
CREATE FUNCTION laboratory_lock_references(relation_name text, record_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; key_column text := 'id';
BEGIN
  IF org IS NULL OR NOT (public.laboratory_can_read() OR public.app_has_permission('masters.manage')) THEN
    RAISE EXCEPTION 'Laboratory reference permission required' USING ERRCODE = '42501';
  END IF;
  IF relation_name IS NULL OR relation_name NOT IN ('sample_categories', 'customers', 'customer_quotations', 'products', 'product_sample_categories',
    'test_parameters', 'methods_of_analysis', 'parameter_methods', 'decision_rules', 'measurement_units', 'laboratories')
    OR record_ids IS NULL OR cardinality(record_ids) > 5000 OR array_position(record_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid scientific reference selection' USING ERRCODE = '23514';
  END IF;
  IF relation_name = 'product_sample_categories' THEN key_column := 'product_id'; END IF;
  IF relation_name = 'parameter_methods' THEN key_column := 'test_parameter_id'; END IF;
  -- Identifiers are allowlisted above; tenant and IDs remain bound values.
  EXECUTE format('SELECT 1 FROM public.%I WHERE organization_id = $1 AND %I = ANY($2) ORDER BY %I FOR SHARE', relation_name, key_column, key_column)
    USING org, record_ids;
END $$;
REVOKE ALL ON FUNCTION laboratory_lock_references(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_lock_references(text, uuid[]) TO sampleify_app;
