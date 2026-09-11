CREATE FUNCTION laboratory_lock_sample(sample_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate')) THEN
    RAISE EXCEPTION 'Sample allocation permission required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.samples WHERE organization_id = org AND id = sample_id FOR UPDATE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION laboratory_lock_sample(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_lock_sample(uuid) TO sampleify_app;

CREATE FUNCTION laboratory_guard_capture_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.template_instance_id IS NOT NULL AND NEW.template_instance_id IS DISTINCT FROM OLD.template_instance_id THEN
    RAISE EXCEPTION 'A runtime capture cannot be replaced silently' USING ERRCODE = '55000';
  END IF;
  IF NEW.template_instance_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.template_instances WHERE organization_id = NEW.organization_id AND id = NEW.template_instance_id FOR UPDATE;
  IF TG_TABLE_NAME = 'samples' THEN
    IF EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id = NEW.organization_id AND template_instance_id = NEW.template_instance_id)
      OR NOT EXISTS (SELECT 1 FROM public.template_instances i JOIN public.template_versions v ON v.organization_id = i.organization_id AND v.id = i.version_id
        WHERE i.organization_id = NEW.organization_id AND i.id = NEW.template_instance_id AND v.kind = 'sample') THEN
      RAISE EXCEPTION 'Sample capture ownership or template type is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.samples WHERE organization_id = NEW.organization_id AND template_instance_id = NEW.template_instance_id) THEN
    RAISE EXCEPTION 'A capture cannot belong to both a sample and a datasheet' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_sample_capture_guard BEFORE INSERT OR UPDATE ON samples FOR EACH ROW EXECUTE FUNCTION laboratory_guard_capture_owner();
CREATE TRIGGER laboratory_datasheet_capture_guard BEFORE INSERT OR UPDATE ON datasheets FOR EACH ROW EXECUTE FUNCTION laboratory_guard_capture_owner();

-- Sample-template editing is a separate workflow-authorized operation. It must
-- not fall through the standalone designer-capture path while that adapter is built.
CREATE POLICY sample_capture_edit_gate ON template_instances AS RESTRICTIVE FOR UPDATE TO sampleify_app USING
  (NOT EXISTS (SELECT 1 FROM samples WHERE organization_id = template_instances.organization_id AND template_instance_id = template_instances.id));
DO $$ DECLARE relation text; operation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_values', 'template_occurrences'] LOOP
    FOREACH operation IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
      IF operation = 'INSERT' THEN
        EXECUTE format('CREATE POLICY sample_capture_insert_gate ON %I AS RESTRICTIVE FOR INSERT TO sampleify_app WITH CHECK
          (NOT EXISTS (SELECT 1 FROM samples WHERE organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid
            AND template_instance_id = nullif(current_setting(''app.capture_id'', true), '''')::uuid))', relation);
      ELSE
        EXECUTE format('CREATE POLICY sample_capture_edit_gate ON %I AS RESTRICTIVE FOR UPDATE TO sampleify_app USING
          (NOT EXISTS (SELECT 1 FROM samples WHERE organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid
            AND template_instance_id = nullif(current_setting(''app.capture_id'', true), '''')::uuid))', relation);
      END IF;
    END LOOP;
  END LOOP;
END $$;
