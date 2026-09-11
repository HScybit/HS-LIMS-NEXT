-- Registration is a separate permission from editing existing samples. Context
-- identifies a new sample; actual actor/time checks keep it transaction-scoped.
CREATE FUNCTION laboratory_registering_sample() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM public.samples
  WHERE organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND id = nullif(current_setting('app.registration_sample_id', true), '')::uuid
    AND registered_by = nullif(current_setting('app.user_id', true), '')::uuid
    AND registered_at = transaction_timestamp() AND revision = 1 AND status = 'registered'
    AND public.app_has_permission('samples.create')
$$;
REVOKE ALL ON FUNCTION laboratory_registering_sample() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_registering_sample() TO sampleify_app;

CREATE FUNCTION laboratory_guard_sample_registration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'sampleify_app' THEN
    IF NOT public.app_has_permission('samples.create') OR NEW.status <> 'registered' OR NEW.revision <> 1
      OR NEW.id IS DISTINCT FROM nullif(current_setting('app.registration_sample_id', true), '')::uuid THEN
      RAISE EXCEPTION 'Sample creation permission and registration context required' USING ERRCODE = '42501';
    END IF;
    NEW.registered_at := transaction_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_registration_guard BEFORE INSERT ON samples FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_registration();
CREATE POLICY registration_insert ON samples FOR INSERT TO sampleify_app WITH CHECK
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('samples.create')));
CREATE POLICY registration_read ON samples FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND id = (SELECT laboratory_registering_sample()));

DO $$ DECLARE relation text; scope_predicate text; BEGIN
  FOR relation, scope_predicate IN SELECT * FROM (VALUES
    ('sample_products', 'sample_id = (SELECT laboratory_registering_sample())'),
    ('sample_participating_labs', 'sample_id = (SELECT laboratory_registering_sample())'),
    ('sample_tests', 'EXISTS (SELECT 1 FROM sample_products p WHERE p.organization_id = sample_tests.organization_id AND p.id = sample_tests.sample_product_id AND p.sample_id = (SELECT laboratory_registering_sample()))'),
    ('workflow_runs', 'sample_id = (SELECT laboratory_registering_sample()) AND test_request_id IS NULL'),
    ('workflow_run_history', 'EXISTS (SELECT 1 FROM workflow_runs r WHERE r.organization_id = workflow_run_history.organization_id AND r.id = workflow_run_history.workflow_run_id AND r.sample_id = (SELECT laboratory_registering_sample()))'),
    ('sample_events', 'sample_id = (SELECT laboratory_registering_sample()) AND test_request_id IS NULL'),
    ('test_requests', 'EXISTS (SELECT 1 FROM sample_tests t JOIN sample_products p ON p.organization_id = t.organization_id AND p.id = t.sample_product_id WHERE t.organization_id = test_requests.organization_id AND t.id = test_requests.sample_test_id AND p.sample_id = (SELECT laboratory_registering_sample()))'),
    ('analytical_specifications', '(SELECT laboratory_registering_sample()) IS NOT NULL AND recorded_by = nullif(current_setting(''app.user_id'', true), '''')::uuid AND recorded_at = transaction_timestamp()'),
    ('analytical_specification_limits', 'EXISTS (SELECT 1 FROM analytical_specifications s WHERE s.organization_id = analytical_specification_limits.organization_id AND s.id = analytical_specification_limits.specification_id AND s.recorded_by = nullif(current_setting(''app.user_id'', true), '''')::uuid AND s.recorded_at = transaction_timestamp() AND (SELECT laboratory_registering_sample()) IS NOT NULL)')
  ) AS scopes(relation, predicate) LOOP
    EXECUTE format('CREATE POLICY registration_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (%s))', relation, scope_predicate);
    EXECUTE format('CREATE POLICY registration_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (%s))', relation, scope_predicate);
  END LOOP;
END $$;
CREATE POLICY registration_generate ON sample_tests FOR UPDATE TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND status = 'planned'
    AND EXISTS (SELECT 1 FROM sample_products p WHERE p.organization_id = sample_tests.organization_id AND p.id = sample_tests.sample_product_id AND p.sample_id = (SELECT laboratory_registering_sample())))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND status = 'requested'
    AND EXISTS (SELECT 1 FROM sample_products p WHERE p.organization_id = sample_tests.organization_id AND p.id = sample_tests.sample_product_id AND p.sample_id = (SELECT laboratory_registering_sample())));

-- Read only the reference families required to validate registration, without
-- conferring master/workflow authoring or broad sample/runtime read permission.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['measurement_units', 'laboratories', 'sample_categories', 'products', 'product_sample_categories',
    'customers', 'customer_addresses', 'customer_contacts', 'customer_quotations', 'test_parameters', 'methods_of_analysis', 'parameter_methods',
    'decision_rules', 'decision_rule_limits', 'sample_category_templates', 'workflows', 'workflow_versions', 'workflow_states', 'workflow_state_capability_roles', 'sample_category_workflows',
    'templates', 'template_versions', 'template_sections', 'template_rows', 'template_columns', 'template_fields', 'template_numeric_config',
    'template_options', 'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('CREATE POLICY registration_reference_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''samples.create'')))', relation);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION laboratory_lock_references(relation_name text, record_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; key_column text := 'id';
BEGIN
  IF org IS NULL OR NOT (public.laboratory_can_read() OR public.app_has_permission('samples.create') OR public.app_has_permission('masters.manage')) THEN
    RAISE EXCEPTION 'Laboratory reference permission required' USING ERRCODE = '42501';
  END IF;
  IF relation_name IS NULL OR relation_name NOT IN ('sample_categories', 'customers', 'customer_quotations', 'products', 'product_sample_categories',
    'test_parameters', 'methods_of_analysis', 'parameter_methods', 'decision_rules', 'measurement_units', 'laboratories')
    OR record_ids IS NULL OR cardinality(record_ids) > 5000 OR array_position(record_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid scientific reference selection' USING ERRCODE = '23514';
  END IF;
  IF relation_name = 'product_sample_categories' THEN key_column := 'product_id'; END IF;
  IF relation_name = 'parameter_methods' THEN key_column := 'test_parameter_id'; END IF;
  EXECUTE format('SELECT 1 FROM public.%I WHERE organization_id = $1 AND %I = ANY($2) ORDER BY %I FOR SHARE', relation_name, key_column, key_column)
    USING org, record_ids;
END $$;

CREATE OR REPLACE FUNCTION laboratory_lock_sample(sample_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate')
    OR sample_id IS NOT DISTINCT FROM public.laboratory_registering_sample() AND sample_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Sample allocation permission required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.samples WHERE organization_id = org AND id = sample_id FOR UPDATE;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION laboratory_next_number(sequence_name text, period text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; next_number bigint; result_prefix text; width integer;
BEGIN
  IF org IS NULL OR sequence_name IS NULL OR period IS NULL OR period !~ '^[0-9]{4}$'
    OR sequence_name NOT IN ('sample', 'test_request', 'job') THEN RAISE EXCEPTION 'Invalid number sequence' USING ERRCODE = '23514'; END IF;
  IF NOT (sequence_name = 'sample' AND public.app_has_permission('samples.create')
    OR sequence_name <> 'sample' AND (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate') OR public.laboratory_registering_sample() IS NOT NULL)) THEN
    RAISE EXCEPTION 'Number allocation permission required' USING ERRCODE = '42501';
  END IF;
  result_prefix := CASE sequence_name WHEN 'sample' THEN 'SMP-' WHEN 'test_request' THEN 'TR-' ELSE 'JOB-' END || period || '-';
  INSERT INTO public.number_sequences (organization_id, sequence_key, period_key, prefix, minimum_width)
    VALUES (org, sequence_name, period, result_prefix, CASE sequence_name WHEN 'job' THEN 4 ELSE 6 END) ON CONFLICT DO NOTHING;
  UPDATE public.number_sequences SET next_value = next_value + 1 WHERE organization_id = org AND sequence_key = sequence_name AND period_key = period
    RETURNING next_value - 1, prefix, minimum_width INTO next_number, result_prefix, width;
  RETURN result_prefix || lpad(next_number::text, greatest(width, length(next_number::text)), '0');
END $$;

CREATE OR REPLACE FUNCTION laboratory_guard_sample_test() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE product public.sample_products;
BEGIN
  SELECT * INTO product FROM public.sample_products WHERE organization_id = NEW.organization_id AND id = NEW.sample_product_id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sample_product_id IS DISTINCT FROM OLD.sample_product_id THEN RAISE EXCEPTION 'A selected test cannot move to another sample product' USING ERRCODE = '23514'; END IF;
    IF (NEW.test_parameter_id, NEW.method_id, NEW.decision_rule_id, NEW.requested_quantity, NEW.requested_size, NEW.rate, NEW.currency_code,
      NEW.estimated_duration_minutes, NEW.is_accredited, NEW.is_retest, NEW.is_subcontracted, NEW.display_order)
      IS DISTINCT FROM (OLD.test_parameter_id, OLD.method_id, OLD.decision_rule_id, OLD.requested_quantity, OLD.requested_size, OLD.rate, OLD.currency_code,
      OLD.estimated_duration_minutes, OLD.is_accredited, OLD.is_retest, OLD.is_subcontracted, OLD.display_order) THEN
      IF OLD.status <> 'planned' OR EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id = OLD.organization_id AND sample_test_id = OLD.id)
        OR (current_user = 'sampleify_app' AND NOT public.app_has_permission('samples.manage')) THEN
        RAISE EXCEPTION 'Requested test specifications cannot be edited' USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSIF current_user = 'sampleify_app' AND NOT (public.app_has_permission('samples.manage')
    OR coalesce(NEW.status = 'planned' AND product.sample_id = public.laboratory_registering_sample(), false)) THEN
    RAISE EXCEPTION 'Sample creation or management permission required' USING ERRCODE = '42501';
  END IF;
  IF NEW.decision_rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.decision_rules rule
    WHERE rule.organization_id = NEW.organization_id AND rule.id = NEW.decision_rule_id AND rule.product_id = product.product_id
      AND rule.test_parameter_id = NEW.test_parameter_id AND (rule.method_id IS NULL OR rule.method_id = NEW.method_id)
      AND (rule.sample_category_id IS NULL OR rule.sample_category_id = product.sample_category_id)) THEN
    RAISE EXCEPTION 'Decision rule does not match the selected test and product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A creator may initialize its new sample capture. Bound sample editing and
-- datasheet execution still require their independent authorization adapters.
CREATE FUNCTION laboratory_registration_capture() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.id FROM public.template_instances i JOIN public.template_versions v ON v.organization_id = i.organization_id AND v.id = i.version_id
    WHERE i.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
      AND i.id = nullif(current_setting('app.capture_id', true), '')::uuid AND i.created_by = nullif(current_setting('app.user_id', true), '')::uuid
      AND i.created_at = transaction_timestamp() AND i.revision = 1 AND i.status = 'editing' AND v.kind = 'sample' AND public.app_has_permission('samples.create')
      AND NOT EXISTS (SELECT 1 FROM public.samples s WHERE s.organization_id = i.organization_id AND s.template_instance_id = i.id)
$$;
REVOKE ALL ON FUNCTION laboratory_registration_capture() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_registration_capture() TO sampleify_app;
CREATE POLICY registration_capture_insert ON template_instances FOR INSERT TO sampleify_app WITH CHECK
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND created_by = nullif(current_setting('app.user_id', true), '')::uuid
    AND id = nullif(current_setting('app.capture_id', true), '')::uuid AND revision = 1 AND created_at = transaction_timestamp()
    AND (SELECT app_has_permission('samples.create')) AND EXISTS (SELECT 1 FROM template_versions v WHERE v.organization_id = template_instances.organization_id AND v.id = template_instances.version_id AND v.kind = 'sample'));
CREATE POLICY registration_capture_read ON template_instances FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND id = (SELECT laboratory_registration_capture()));
-- Existing value/repeat guards lock the parent using FOR UPDATE. USING permits
-- that lock; WITH CHECK false grants no capture revision/status update.
CREATE POLICY registration_capture_lock ON template_instances FOR UPDATE TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND id = (SELECT laboratory_registration_capture())) WITH CHECK (false);
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_occurrences', 'template_values'] LOOP
    EXECUTE format('CREATE POLICY registration_capture_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND instance_id = (SELECT laboratory_registration_capture()))', relation);
    EXECUTE format('CREATE POLICY registration_capture_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND instance_id = (SELECT laboratory_registration_capture()))', relation);
  END LOOP;
END $$;
