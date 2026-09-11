-- Tenant and permission predicates are constant for each statement. Domain
-- services additionally enforce the current workflow state and assignee.
CREATE FUNCTION laboratory_can_read() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT public.app_has_permission('samples.read') OR public.app_has_permission('samples.manage')
    OR public.app_has_permission('test_requests.allocate') OR public.app_has_permission('datasheets.execute')
    OR public.app_has_permission('approvals.respond')
$$;

DO $$ DECLARE relation text; permission text; BEGIN
  FOREACH relation IN ARRAY ARRAY['measurement_units', 'laboratories', 'sample_categories', 'products',
    'product_sample_categories', 'customers', 'customer_addresses', 'customer_contacts', 'customer_quotations',
    'test_parameters', 'methods_of_analysis', 'parameter_methods', 'decision_rules', 'decision_rule_limits', 'sample_category_templates',
    'workflows', 'workflow_versions', 'workflow_states', 'workflow_state_capability_roles', 'sample_category_workflows'] LOOP
    permission := CASE WHEN relation IN ('workflows', 'workflow_versions', 'workflow_states', 'workflow_state_capability_roles', 'sample_category_workflows')
      THEN 'workflows.manage' ELSE 'masters.manage' END;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY laboratory_definition_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
      (SELECT laboratory_can_read() OR app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')
        OR app_has_permission(''workflows.read'') OR app_has_permission(''workflows.manage'')))', relation);
    EXECUTE format('CREATE POLICY laboratory_definition_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(%L)))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(%L)))', relation, permission, permission);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sampleify_app', relation);
  END LOOP;
  FOR relation, permission IN SELECT * FROM (VALUES
    ('samples', 'app_has_permission(''samples.manage'')'),
    ('sample_products', 'app_has_permission(''samples.manage'')'),
    ('sample_participating_labs', 'app_has_permission(''samples.manage'')'),
    ('sample_tests', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'')'),
    ('test_requests', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')'),
    ('test_request_assignments', 'app_has_permission(''test_requests.allocate'')'),
    ('datasheets', 'app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')'),
    ('analytical_specifications', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')'),
    ('analytical_specification_limits', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')'),
    ('workflow_runs', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')'),
    ('workflow_run_history', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')'),
    ('sample_events', 'app_has_permission(''samples.manage'') OR app_has_permission(''test_requests.allocate'') OR app_has_permission(''datasheets.execute'')')
  ) AS permissions(relation, permission) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY laboratory_record_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT laboratory_can_read()))', relation);
    EXECUTE format('CREATE POLICY laboratory_record_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT %s))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT %s))', relation, permission, permission);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO sampleify_app', relation);
  END LOOP;
END $$;
REVOKE UPDATE ON analytical_specifications, analytical_specification_limits, workflow_run_history, sample_events FROM sampleify_app;

CREATE FUNCTION laboratory_guard_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.organization_id, NEW.id) IS DISTINCT FROM (OLD.organization_id, OLD.id) THEN
    RAISE EXCEPTION 'Laboratory record identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['measurement_units', 'laboratories', 'sample_categories', 'products', 'customers',
    'customer_addresses', 'customer_contacts', 'customer_quotations', 'test_parameters', 'methods_of_analysis', 'decision_rules', 'decision_rule_limits',
    'workflows', 'workflow_versions', 'workflow_states', 'samples', 'sample_products', 'sample_tests', 'sample_participating_labs',
    'test_requests', 'test_request_assignments', 'datasheets', 'workflow_runs'] LOOP
    EXECUTE format('CREATE TRIGGER laboratory_identity_guard BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION laboratory_guard_identity()', relation);
  END LOOP;
END $$;

CREATE FUNCTION laboratory_guard_master_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Master changes require the next revision and original creation time' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['measurement_units', 'laboratories', 'sample_categories', 'products', 'customers', 'test_parameters', 'methods_of_analysis', 'decision_rules'] LOOP
    EXECUTE format('CREATE TRIGGER laboratory_master_revision_guard BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION laboratory_guard_master_revision()', relation);
  END LOOP;
END $$;

CREATE FUNCTION laboratory_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'Recorded laboratory history is immutable' USING ERRCODE = '55000'; END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['analytical_specifications', 'analytical_specification_limits', 'workflow_run_history', 'sample_events'] LOOP
    EXECUTE format('CREATE TRIGGER laboratory_history_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION laboratory_append_only()', relation);
  END LOOP;
END $$;

-- Lock the rule for child edits, so specification snapshots cannot see a mixture
-- of old scalar criteria and new limit rows during concurrent master changes.
CREATE FUNCTION laboratory_guard_rule_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public.decision_rules WHERE organization_id = OLD.organization_id AND id = OLD.decision_rule_id FOR UPDATE;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.decision_rule_id IS DISTINCT FROM OLD.decision_rule_id THEN
    RAISE EXCEPTION 'A rule limit cannot move to another rule' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.decision_rules WHERE organization_id = NEW.organization_id AND id = NEW.decision_rule_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_rule_limit_guard BEFORE INSERT OR UPDATE OR DELETE ON decision_rule_limits
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_rule_limit();

CREATE FUNCTION laboratory_guard_specification_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.analytical_specifications WHERE organization_id = NEW.organization_id AND id = NEW.specification_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id = NEW.organization_id AND specification_id = NEW.specification_id)
    OR EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id = NEW.organization_id AND specification_id = NEW.specification_id) THEN
    RAISE EXCEPTION 'A referenced analytical specification is frozen' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_specification_limit_guard BEFORE INSERT ON analytical_specification_limits
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_specification_limit();

CREATE FUNCTION laboratory_guard_workflow_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.revision <> 1 THEN RAISE EXCEPTION 'Workflow versions start as drafts' USING ERRCODE = '23514'; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Published workflow history cannot be deleted' USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  ELSE
    IF (NEW.workflow_id, NEW.number, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.workflow_id, OLD.number, OLD.created_by, OLD.created_at)
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Workflow identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
    IF OLD.status <> 'draft' AND (OLD.status <> 'published' OR NEW.status <> 'retired'
      OR (NEW.change_summary, NEW.published_at, NEW.published_by) IS DISTINCT FROM (OLD.change_summary, OLD.published_at, OLD.published_by)) THEN
      RAISE EXCEPTION 'Published workflow versions are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.status = 'published' AND NOT EXISTS (SELECT 1 FROM public.workflow_states
    WHERE organization_id = NEW.organization_id AND workflow_version_id = NEW.id AND state_type = 'initial') THEN
    RAISE EXCEPTION 'Published workflow requires an initial state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_workflow_version_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_workflow_version();

CREATE FUNCTION laboratory_guard_workflow_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org uuid; ver uuid; state_id uuid; state text;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; ELSE org := NEW.organization_id; END IF;
  IF TG_TABLE_NAME = 'workflow_states' THEN
    IF TG_OP = 'DELETE' THEN ver := OLD.workflow_version_id; ELSE ver := NEW.workflow_version_id; END IF;
    IF TG_OP = 'UPDATE' AND NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id THEN
      RAISE EXCEPTION 'Workflow state ownership is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN state_id := OLD.workflow_state_id; ELSE state_id := NEW.workflow_state_id; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.workflow_state_id) IS DISTINCT FROM (OLD.organization_id, OLD.workflow_state_id) THEN
      RAISE EXCEPTION 'Workflow capability ownership is immutable' USING ERRCODE = '23514';
    END IF;
    SELECT workflow_version_id INTO ver FROM public.workflow_states WHERE organization_id = org AND id = state_id;
  END IF;
  SELECT status INTO state FROM public.workflow_versions WHERE organization_id = org AND id = ver FOR UPDATE;
  IF state IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only draft workflow definitions may change' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_workflow_state_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_states
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_workflow_definition();
CREATE TRIGGER laboratory_workflow_capability_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_state_capability_roles
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_workflow_definition();

CREATE FUNCTION laboratory_guard_workflow_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE owner_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT w.applies_to INTO owner_type FROM public.workflow_versions v JOIN public.workflows w
      ON w.organization_id = v.organization_id AND w.id = v.workflow_id
      JOIN public.workflow_states s ON s.organization_id = v.organization_id AND s.workflow_version_id = v.id
      WHERE v.organization_id = NEW.organization_id AND v.id = NEW.workflow_version_id AND v.status = 'published' AND w.active
        AND s.id = NEW.current_state_id AND s.state_type = 'initial';
    IF owner_type IS DISTINCT FROM (CASE WHEN NEW.sample_id IS NOT NULL THEN 'sample' ELSE 'test_request' END)
      OR NEW.revision <> 1 OR NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Workflow run requires a published initial state for its owner type' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.workflow_version_id, NEW.sample_id, NEW.test_request_id, NEW.started_by, NEW.started_at)
      IS DISTINCT FROM (OLD.workflow_version_id, OLD.sample_id, OLD.test_request_id, OLD.started_by, OLD.started_at)
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Workflow run identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_workflow_run_guard BEFORE INSERT OR UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_workflow_run();

ALTER TABLE number_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY sequence_read ON number_sequences FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND
    (SELECT app_has_permission('samples.manage') OR app_has_permission('test_requests.allocate')));
GRANT SELECT ON number_sequences TO sampleify_app;
CREATE FUNCTION laboratory_next_number(sequence_name text, period text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; next_number bigint; result_prefix text; width integer;
BEGIN
  IF org IS NULL OR sequence_name IS NULL OR period IS NULL OR period !~ '^[0-9]{4}$'
    OR sequence_name NOT IN ('sample', 'test_request', 'job') THEN RAISE EXCEPTION 'Invalid number sequence' USING ERRCODE = '23514'; END IF;
  IF NOT (public.app_has_permission('samples.manage') OR (sequence_name <> 'sample' AND public.app_has_permission('test_requests.allocate'))) THEN
    RAISE EXCEPTION 'Number allocation permission required' USING ERRCODE = '42501';
  END IF;
  result_prefix := CASE sequence_name WHEN 'sample' THEN 'SMP-' WHEN 'test_request' THEN 'TR-' ELSE 'JOB-' END || period || '-';
  INSERT INTO public.number_sequences (organization_id, sequence_key, period_key, prefix, minimum_width)
    VALUES (org, sequence_name, period, result_prefix, CASE sequence_name WHEN 'job' THEN 4 ELSE 6 END) ON CONFLICT DO NOTHING;
  UPDATE public.number_sequences SET next_value = next_value + 1 WHERE organization_id = org AND sequence_key = sequence_name AND period_key = period
    RETURNING next_value - 1, prefix, minimum_width INTO next_number, result_prefix, width;
  RETURN result_prefix || lpad(next_number::text, greatest(width, length(next_number::text)), '0');
END $$;
REVOKE ALL ON FUNCTION laboratory_next_number(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_next_number(text, text) TO sampleify_app;

CREATE FUNCTION laboratory_assignment_users() RETURNS TABLE(user_id uuid, display_name text, username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.display_name, u.username FROM public.users u JOIN public.memberships m ON m.user_id = u.id
    WHERE m.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND m.active AND u.active
      AND public.app_has_permission('test_requests.allocate') ORDER BY u.display_name, u.id
$$;
REVOKE ALL ON FUNCTION laboratory_assignment_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_assignment_users() TO sampleify_app;

CREATE FUNCTION laboratory_guard_sample_test() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE product public.sample_products;
BEGIN
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
  ELSIF current_user = 'sampleify_app' AND NOT public.app_has_permission('samples.manage') THEN
    RAISE EXCEPTION 'Sample management permission required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO product FROM public.sample_products WHERE organization_id = NEW.organization_id AND id = NEW.sample_product_id;
  IF NEW.decision_rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.decision_rules rule
    WHERE rule.organization_id = NEW.organization_id AND rule.id = NEW.decision_rule_id AND rule.product_id = product.product_id
      AND rule.test_parameter_id = NEW.test_parameter_id AND (rule.method_id IS NULL OR rule.method_id = NEW.method_id)
      AND (rule.sample_category_id IS NULL OR rule.sample_category_id = product.sample_category_id)) THEN
    RAISE EXCEPTION 'Decision rule does not match the selected test and product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_sample_test_guard BEFORE INSERT OR UPDATE ON sample_tests FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_test();

CREATE FUNCTION laboratory_guard_test_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE specification public.analytical_specifications; selected public.sample_tests;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.sample_test_id, NEW.specification_id, NEW.request_number, NEW.parent_test_request_id, NEW.attempt_number, NEW.datasheet_template_id, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.sample_test_id, OLD.specification_id, OLD.request_number, OLD.parent_test_request_id, OLD.attempt_number, OLD.datasheet_template_id, OLD.created_by, OLD.created_at)
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Test request identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.status <> 'created' OR NEW.revision <> 1 THEN RAISE EXCEPTION 'Test requests start as created records' USING ERRCODE = '23514'; END IF;
    SELECT * INTO specification FROM public.analytical_specifications WHERE organization_id = NEW.organization_id AND id = NEW.specification_id FOR SHARE;
    SELECT * INTO selected FROM public.sample_tests WHERE organization_id = NEW.organization_id AND id = NEW.sample_test_id;
    IF specification.id IS NULL OR selected.id IS NULL OR (specification.test_parameter_id, specification.method_id, specification.decision_rule_id)
      IS DISTINCT FROM (selected.test_parameter_id, selected.method_id, selected.decision_rule_id) THEN
      RAISE EXCEPTION 'Analytical specification does not match the selected test' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_test_request_guard BEFORE INSERT OR UPDATE ON test_requests FOR EACH ROW EXECUTE FUNCTION laboratory_guard_test_request();

CREATE FUNCTION laboratory_guard_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE request_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.test_request_id, NEW.assigned_user_id, NEW.assignment_type, NEW.assigned_by, NEW.assigned_at)
      IS DISTINCT FROM (OLD.test_request_id, OLD.assigned_user_id, OLD.assignment_type, OLD.assigned_by, OLD.assigned_at)
      OR OLD.unassigned_at IS NOT NULL OR NEW.unassigned_at IS NULL THEN
      RAISE EXCEPTION 'Assignment history can only end an active assignment' USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT status INTO request_status FROM public.test_requests WHERE organization_id = NEW.organization_id AND id = NEW.test_request_id FOR UPDATE;
    IF request_status IS NULL OR request_status IN ('approved', 'cancelled') THEN RAISE EXCEPTION 'Closed test requests cannot be allocated' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
      WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.assigned_user_id AND m.active AND u.active) THEN
      RAISE EXCEPTION 'The selected user is not active in this organization' USING ERRCODE = '23514';
    END IF;
    IF NEW.assignment_type IN ('analyst', 'reviewer') AND EXISTS (SELECT 1 FROM public.test_request_assignments
      WHERE organization_id = NEW.organization_id AND test_request_id = NEW.test_request_id AND assigned_user_id = NEW.assigned_user_id
        AND assignment_type = CASE NEW.assignment_type WHEN 'analyst' THEN 'reviewer' ELSE 'analyst' END AND unassigned_at IS NULL) THEN
      RAISE EXCEPTION 'Assignee and reviewer cannot be the same' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_assignment_guard BEFORE INSERT OR UPDATE ON test_request_assignments FOR EACH ROW EXECUTE FUNCTION laboratory_guard_assignment();

CREATE FUNCTION laboratory_guard_datasheet() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.test_request_id, NEW.template_instance_id, NEW.specification_id, NEW.method_id, NEW.attempt_number, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.test_request_id, OLD.template_instance_id, OLD.specification_id, OLD.method_id, OLD.attempt_number, OLD.created_by, OLD.created_at)
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Datasheet identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
  ELSE
    PERFORM 1 FROM public.analytical_specifications WHERE organization_id = NEW.organization_id AND id = NEW.specification_id FOR SHARE;
    IF NEW.status <> 'in_progress' OR NEW.revision <> 1 OR NOT EXISTS (SELECT 1 FROM public.template_instances i JOIN public.template_versions v
      ON v.organization_id = i.organization_id AND v.id = i.version_id
      WHERE i.organization_id = NEW.organization_id AND i.id = NEW.template_instance_id AND i.status = 'editing' AND v.kind = 'datasheet') THEN
      RAISE EXCEPTION 'A datasheet requires a new editable capture with a datasheet template' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_datasheet_guard BEFORE INSERT OR UPDATE ON datasheets FOR EACH ROW EXECUTE FUNCTION laboratory_guard_datasheet();

CREATE FUNCTION laboratory_guard_sample() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.sample_number, NEW.registered_by, NEW.registered_at)
    IS DISTINCT FROM (OLD.sample_number, OLD.registered_by, OLD.registered_at)
    OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Sample registration identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_sample_guard BEFORE UPDATE ON samples FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample();

CREATE FUNCTION laboratory_guard_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE recorded_actor uuid; actual_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF current_user <> 'sampleify_app' THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'samples' THEN recorded_actor := NEW.registered_by;
    WHEN 'analytical_specifications' THEN recorded_actor := NEW.recorded_by;
    WHEN 'test_requests', 'datasheets', 'workflow_versions' THEN recorded_actor := NEW.created_by;
    WHEN 'test_request_assignments' THEN recorded_actor := NEW.assigned_by;
    WHEN 'workflow_runs' THEN recorded_actor := NEW.started_by;
    WHEN 'workflow_run_history', 'sample_events' THEN recorded_actor := NEW.actor_user_id;
  END CASE;
  IF actual_actor IS NULL OR actual_actor IS DISTINCT FROM recorded_actor THEN
    RAISE EXCEPTION 'Recorded actor must match the authenticated user' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['samples', 'analytical_specifications', 'test_requests', 'datasheets', 'workflow_versions',
    'test_request_assignments', 'workflow_runs', 'workflow_run_history', 'sample_events'] LOOP
    EXECUTE format('CREATE TRIGGER laboratory_actor_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION laboratory_guard_actor()', relation);
  END LOOP;
END $$;
