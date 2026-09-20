-- Custom SQL migration file, put your code below! --
-- Domain permission checks supplement transaction-local tenant context and service checks.
CREATE FUNCTION app_has_permission(permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.membership_roles mr
    JOIN public.role_permissions rp USING (organization_id, role_id)
    WHERE mr.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
      AND mr.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND rp.permission_code = permission
  )
$$;
GRANT EXECUTE ON FUNCTION app_has_permission(text) TO sampleify_app;

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['templates', 'template_versions', 'template_sections', 'template_rows',
    'template_columns', 'template_fields', 'template_numeric_config', 'template_options',
    'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY definition_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
      (app_has_permission(''templates.read'') OR app_has_permission(''templates.manage'') OR app_has_permission(''datasheets.execute'')))', relation);
    EXECUTE format('CREATE POLICY definition_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND app_has_permission(''templates.manage''))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND app_has_permission(''templates.manage''))', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sampleify_app', relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['template_instances', 'template_occurrences', 'template_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY capture_scope ON %I TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND app_has_permission(''datasheets.execute''))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND app_has_permission(''datasheets.execute''))', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO sampleify_app', relation);
  END LOOP;
END $$;
REVOKE UPDATE ON template_values FROM sampleify_app;

-- Deferred sibling uniqueness permits atomic reordering without temporary negative positions.
ALTER TABLE template_sections ADD CONSTRAINT section_sibling_order_key UNIQUE NULLS NOT DISTINCT
  (organization_id, version_id, parent_column_id, position) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE template_rows ADD CONSTRAINT row_sibling_order_key UNIQUE
  (organization_id, version_id, section_id, position) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE template_columns ADD CONSTRAINT column_sibling_order_key UNIQUE
  (organization_id, version_id, row_id, position) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE template_expression_nodes ADD CONSTRAINT expression_operand_key UNIQUE NULLS NOT DISTINCT
  (organization_id, version_id, expression_id, parent_index, operand_order) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX expression_root_key ON template_expression_nodes(organization_id, version_id, expression_id)
  WHERE parent_index IS NULL;
ALTER TABLE template_expression_nodes ADD CONSTRAINT expression_payload_strict CHECK
  ((kind = 'field') = (reference_scope IS NOT NULL) AND
   (kind IN ('unary', 'binary')) = (operator IS NOT NULL) AND
   (kind = 'call') = (function_name IS NOT NULL) AND
   (parent_index IS NOT NULL OR operand_order = 0));
CREATE UNIQUE INDEX occurrence_active_order_key ON template_occurrences
  (organization_id, instance_id, parent_id, group_id, position) WHERE removed_revision IS NULL AND group_id IS NOT NULL;

CREATE FUNCTION template_guard_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'New versions start as drafts' USING ERRCODE = '23514'; END IF;
  ELSE
    IF OLD.status = 'frozen' THEN RAISE EXCEPTION 'Frozen template versions are immutable' USING ERRCODE = '55000'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF (NEW.organization_id, NEW.id, NEW.template_id, NEW.number, NEW.created_by, NEW.created_at, NEW.source_version_id)
      IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.template_id, OLD.number, OLD.created_by, OLD.created_at, OLD.source_version_id) THEN
      RAISE EXCEPTION 'Template version identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Template changes require the next revision' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.source_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.template_versions
    WHERE organization_id = NEW.organization_id AND id = NEW.source_version_id AND status = 'frozen') THEN
    RAISE EXCEPTION 'Source version must be frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_version_guard BEFORE INSERT OR UPDATE OR DELETE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION template_guard_version();

CREATE FUNCTION template_guard_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org uuid; ver uuid; state text;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; ver := OLD.version_id;
  ELSE org := NEW.organization_id; ver := NEW.version_id; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.version_id) IS DISTINCT FROM (OLD.organization_id, OLD.version_id) THEN
    RAISE EXCEPTION 'Definition ownership is immutable' USING ERRCODE = '23514';
  END IF;
  -- Every structural write locks the same version as freeze, closing the edit/freeze race.
  SELECT status INTO state FROM public.template_versions WHERE organization_id = org AND id = ver FOR UPDATE;
  IF state IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only draft definitions may change' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_fields',
    'template_numeric_config', 'template_options', 'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('CREATE TRIGGER definition_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION template_guard_definition()', relation);
  END LOOP;
END $$;

CREATE FUNCTION template_guard_instance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Capture history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'editing' OR NEW.revision <> 1 OR NOT EXISTS (SELECT 1 FROM public.template_versions
      WHERE organization_id = NEW.organization_id AND id = NEW.version_id AND status = 'frozen') THEN
      RAISE EXCEPTION 'Capture requires a frozen template and an initial editing revision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status = 'frozen' THEN RAISE EXCEPTION 'Frozen capture is immutable' USING ERRCODE = '55000'; END IF;
    IF (NEW.organization_id, NEW.id, NEW.version_id, NEW.created_at, NEW.created_by)
      IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.version_id, OLD.created_at, OLD.created_by) OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Capture identity is immutable and revisions are sequential' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_instance_guard BEFORE INSERT OR UPDATE OR DELETE ON template_instances
  FOR EACH ROW EXECUTE FUNCTION template_guard_instance();

CREATE FUNCTION template_guard_occurrence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE capture public.template_instances; parent public.template_occurrences; definition public.template_repeat_groups;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Repeat history cannot be deleted' USING ERRCODE = '55000'; END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id = NEW.organization_id AND id = NEW.instance_id FOR UPDATE;
  IF capture.status IS DISTINCT FROM 'editing' OR capture.version_id <> NEW.version_id THEN
    RAISE EXCEPTION 'Repeat requires its editable capture version' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.created_revision <> capture.revision THEN
    RAISE EXCEPTION 'Repeat creation revision must match capture' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((NEW.organization_id, NEW.instance_id, NEW.version_id, NEW.id, NEW.group_id, NEW.parent_id, NEW.created_revision)
    IS DISTINCT FROM (OLD.organization_id, OLD.instance_id, OLD.version_id, OLD.id, OLD.group_id, OLD.parent_id, OLD.created_revision)
    OR OLD.removed_revision IS NOT NULL OR NEW.removed_revision IS DISTINCT FROM capture.revision) THEN
    RAISE EXCEPTION 'Repeat identity and removal history are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.group_id IS NOT NULL THEN
    SELECT * INTO definition FROM public.template_repeat_groups WHERE organization_id = NEW.organization_id AND version_id = NEW.version_id AND id = NEW.group_id;
    SELECT * INTO parent FROM public.template_occurrences WHERE organization_id = NEW.organization_id AND instance_id = NEW.instance_id AND version_id = NEW.version_id AND id = NEW.parent_id;
    IF definition.id IS NULL OR parent.id IS NULL OR parent.removed_revision IS NOT NULL OR parent.group_id IS DISTINCT FROM definition.parent_group_id THEN
      RAISE EXCEPTION 'Repeat ancestry does not match its definition' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND (SELECT count(*) FROM public.template_occurrences WHERE organization_id = NEW.organization_id AND instance_id = NEW.instance_id
      AND parent_id = NEW.parent_id AND group_id = NEW.group_id AND removed_revision IS NULL) >= definition.maximum THEN
      RAISE EXCEPTION 'Repeat limit exceeded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON template_occurrences
  FOR EACH ROW EXECUTE FUNCTION template_guard_occurrence();

CREATE FUNCTION template_guard_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE capture public.template_instances; occurrence public.template_occurrences; field public.template_fields;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Saved values are append-only' USING ERRCODE = '55000'; END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id = NEW.organization_id AND id = NEW.instance_id FOR UPDATE;
  IF capture.status IS DISTINCT FROM 'editing' OR capture.version_id <> NEW.version_id OR capture.revision <> NEW.revision THEN
    RAISE EXCEPTION 'Value must use the editable capture version and current revision' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO occurrence FROM public.template_occurrences WHERE organization_id = NEW.organization_id AND instance_id = NEW.instance_id AND version_id = NEW.version_id AND id = NEW.occurrence_id;
  SELECT * INTO field FROM public.template_fields WHERE organization_id = NEW.organization_id AND version_id = NEW.version_id AND id = NEW.field_id;
  IF occurrence.id IS NULL OR field.id IS NULL OR occurrence.removed_revision IS NOT NULL OR field.repeat_group_id IS DISTINCT FROM occurrence.group_id THEN
    RAISE EXCEPTION 'Value field and repeat occurrence do not match' USING ERRCODE = '23514';
  END IF;
  IF (field.widget = 'formula_widget') IS DISTINCT FROM (NEW.origin = 'calculated') THEN
    RAISE EXCEPTION 'Calculated fields cannot accept entered values' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_value_guard BEFORE INSERT OR UPDATE OR DELETE ON template_values
  FOR EACH ROW EXECUTE FUNCTION template_guard_value();
