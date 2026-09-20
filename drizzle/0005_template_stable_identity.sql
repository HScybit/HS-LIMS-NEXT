-- Custom SQL migration file, put your code below! --
ALTER TABLE template_sections ALTER CONSTRAINT section_parent_column_fk DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE constraint_name text; BEGIN
  SELECT c.conname INTO constraint_name FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'template_repeat_groups'::regclass AND c.contype = 'f' AND a.attname = 'parent_group_id';
  EXECUTE format('ALTER TABLE template_repeat_groups ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', constraint_name);
END $$;

CREATE FUNCTION template_guard_logical_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'template_expression_nodes' THEN
    IF (NEW.expression_id, NEW.node_index) IS DISTINCT FROM (OLD.expression_id, OLD.node_index) THEN
      RAISE EXCEPTION 'Expression node identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'template_numeric_config' THEN
    IF NEW.field_id IS DISTINCT FROM OLD.field_id THEN RAISE EXCEPTION 'Configuration field identity is immutable' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Logical identity is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_fields',
    'template_numeric_config', 'template_options', 'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('CREATE TRIGGER logical_identity_guard BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION template_guard_logical_identity()', relation);
  END LOOP;
END $$;
