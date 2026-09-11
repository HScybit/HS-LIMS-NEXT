-- Product filtering is a supporting registration dependency, with the same
-- tenant/read/master-management boundary as the other scientific references.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['tags', 'product_tags'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY laboratory_definition_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
      (SELECT laboratory_can_read() OR app_has_permission(''samples.create'') OR app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))', relation);
    EXECUTE format('CREATE POLICY laboratory_definition_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''masters.manage'')))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''masters.manage'')))', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sampleify_app', relation);
  END LOOP;
END $$;
CREATE TRIGGER laboratory_identity_guard BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION laboratory_guard_identity();
CREATE TRIGGER laboratory_master_revision_guard BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION laboratory_guard_master_revision();

CREATE OR REPLACE FUNCTION laboratory_lock_references(relation_name text, record_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; key_column text := 'id';
BEGIN
  IF org IS NULL OR NOT (public.laboratory_can_read() OR public.app_has_permission('samples.create') OR public.app_has_permission('masters.manage')) THEN
    RAISE EXCEPTION 'Laboratory reference permission required' USING ERRCODE = '42501';
  END IF;
  IF relation_name IS NULL OR relation_name NOT IN ('sample_categories', 'customers', 'customer_quotations', 'products', 'product_sample_categories',
    'test_parameters', 'methods_of_analysis', 'parameter_methods', 'decision_rules', 'measurement_units', 'laboratories', 'tags', 'product_tags')
    OR record_ids IS NULL OR cardinality(record_ids) > 5000 OR array_position(record_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid scientific reference selection' USING ERRCODE = '23514';
  END IF;
  IF relation_name IN ('product_sample_categories', 'product_tags') THEN key_column := 'product_id'; END IF;
  IF relation_name = 'parameter_methods' THEN key_column := 'test_parameter_id'; END IF;
  EXECUTE format('SELECT 1 FROM public.%I WHERE organization_id = $1 AND %I = ANY($2) ORDER BY %I FOR SHARE', relation_name, key_column, key_column)
    USING org, record_ids;
END $$;

-- PERN's registration quick-customer endpoint requires samples.create.
-- Expose only creation of this exact new customer/contact/address structure;
-- a registrar still cannot UPDATE masters or INSERT arbitrary child records.
CREATE FUNCTION laboratory_quick_customer(display_name text, legal_name text, contact_name text, contact_email text,
  contact_phone text, billing_address text, shipping_address text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  customer_id uuid := gen_random_uuid(); customer_code text;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('samples.create') THEN
    RAISE EXCEPTION 'Sample registration permission required' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(length(trim(display_name)) BETWEEN 1 AND 250 AND length(trim(legal_name)) BETWEEN 1 AND 250
    AND length(trim(contact_name)) BETWEEN 1 AND 200 AND length(trim(contact_email)) BETWEEN 3 AND 320
    AND trim(contact_email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    AND length(trim(contact_phone)) BETWEEN 1 AND 50 AND length(trim(billing_address)) BETWEEN 1 AND 4000
    AND length(trim(shipping_address)) BETWEEN 1 AND 4000, false) THEN
    RAISE EXCEPTION 'Complete the customer contact and address fields' USING ERRCODE = '23514';
  END IF;
  customer_code := left(trim(both '-' from regexp_replace(upper(trim(display_name)), '[^A-Z0-9._/-]+', '-', 'g')), 64);
  IF customer_code = '' THEN customer_code := 'CUSTOMER'; END IF;
  INSERT INTO public.customers(organization_id, id, code, name, legal_name, credit_days)
    VALUES (org, customer_id, customer_code, trim(display_name), trim(legal_name), 30);
  INSERT INTO public.customer_contacts(organization_id, customer_id, name, email, phone, is_primary)
    VALUES (org, customer_id, trim(contact_name), trim(contact_email), trim(contact_phone), true);
  INSERT INTO public.customer_addresses(organization_id, customer_id, address_type, freeform_address, is_default)
    VALUES (org, customer_id, 'billing', trim(billing_address), true), (org, customer_id, 'shipping', trim(shipping_address), true);
  RETURN customer_id;
END $$;
REVOKE ALL ON FUNCTION laboratory_quick_customer(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_quick_customer(text, text, text, text, text, text, text) TO sampleify_app;
