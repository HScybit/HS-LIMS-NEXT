-- Allocate immutable runtime definitions without granting master-template editing.
CREATE OR REPLACE FUNCTION template_guard_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'building') THEN
      RAISE EXCEPTION 'New versions start as drafts or internal snapshots' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'building' AND current_user <> (
      SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.template_versions'::regclass
    ) THEN
      RAISE EXCEPTION 'Runtime snapshots require the controlled copy operation' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'building' AND NOT EXISTS (SELECT 1 FROM public.template_versions
      WHERE organization_id = NEW.organization_id AND id = NEW.snapshot_source_id
        AND status = 'draft' AND revision = NEW.snapshot_source_revision) THEN
      RAISE EXCEPTION 'Snapshot source revision is unavailable' USING ERRCODE = '40001';
    END IF;
  ELSE
    IF OLD.status = 'frozen' THEN RAISE EXCEPTION 'Frozen template versions are immutable' USING ERRCODE = '55000'; END IF;
    IF OLD.status = 'building' AND (TG_OP = 'DELETE' OR NEW.status <> 'frozen') THEN
      RAISE EXCEPTION 'Internal snapshots must finish as frozen versions' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF (NEW.organization_id, NEW.id, NEW.template_id, NEW.number, NEW.created_by, NEW.created_at,
        NEW.source_version_id, NEW.snapshot_source_id, NEW.snapshot_source_revision)
      IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.template_id, OLD.number, OLD.created_by, OLD.created_at,
        OLD.source_version_id, OLD.snapshot_source_id, OLD.snapshot_source_revision) THEN
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

CREATE OR REPLACE FUNCTION template_guard_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org uuid; ver uuid; state text;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; ver := OLD.version_id;
  ELSE org := NEW.organization_id; ver := NEW.version_id; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.version_id) IS DISTINCT FROM (OLD.organization_id, OLD.version_id) THEN
    RAISE EXCEPTION 'Definition ownership is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO state FROM public.template_versions WHERE organization_id = org AND id = ver FOR UPDATE;
  IF state IS DISTINCT FROM 'draft' AND (state IS DISTINCT FROM 'building' OR TG_OP <> 'INSERT') THEN
    RAISE EXCEPTION 'Only draft definitions may change' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION template_snapshot_finished() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id = NEW.organization_id AND id = NEW.id AND status = 'building') THEN
    RAISE EXCEPTION 'An unfinished runtime snapshot cannot be committed' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER template_snapshot_finished_guard AFTER INSERT OR UPDATE ON template_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION template_snapshot_finished();

CREATE FUNCTION template_snapshot_from_draft(source_id uuid, expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  source public.template_versions; snapshot_id uuid; template_id uuid; relation text; column_names text;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT (
    public.app_has_permission('templates.manage') OR public.app_has_permission('test_requests.allocate')
    OR public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
  ) THEN RAISE EXCEPTION 'Runtime snapshot permission required' USING ERRCODE = '42501'; END IF;
  SELECT v.template_id INTO template_id FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id;
  PERFORM 1 FROM public.templates t WHERE t.organization_id = org AND t.id = template_id AND t.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template is unavailable' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO source FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id FOR UPDATE;
  IF source.status <> 'draft' OR source.revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'Template revision changed' USING ERRCODE = '40001';
  END IF;
  SELECT v.id INTO snapshot_id FROM public.template_versions v WHERE v.organization_id = org
    AND v.snapshot_source_id = source.id AND v.snapshot_source_revision = source.revision AND v.status = 'frozen';
  IF snapshot_id IS NOT NULL THEN RETURN snapshot_id; END IF;
  INSERT INTO public.template_versions (organization_id, template_id, number, status, name, description, kind,
    template_type, semantics, created_by, snapshot_source_id, snapshot_source_revision)
    SELECT org, source.template_id, coalesce(max(v.number), 0) + 1, 'building', source.name, source.description, source.kind,
      source.template_type, source.semantics, actor, source.id, source.revision
    FROM public.template_versions v WHERE v.organization_id = org AND v.template_id = source.template_id RETURNING id INTO snapshot_id;
  -- Only these definition tables are copied. Column identifiers come from PostgreSQL's
  -- catalog, never request data; new typed scalar columns are copied with their version.
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_repeat_groups',
    'template_fields', 'template_numeric_config', 'template_options', 'template_expressions', 'template_expression_nodes'] LOOP
    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO column_names FROM pg_attribute
      WHERE attrelid = format('public.%I', relation)::regclass AND attnum > 0 AND NOT attisdropped
        AND attname NOT IN ('organization_id', 'version_id') AND attgenerated = '';
    EXECUTE format('INSERT INTO public.%I (organization_id, version_id, %s)
      SELECT $1, $2, %s FROM public.%I WHERE organization_id = $1 AND version_id = $3', relation, column_names, column_names, relation)
      USING org, snapshot_id, source.id;
  END LOOP;
  UPDATE public.template_versions SET status = 'frozen', revision = revision + 1, frozen_at = now(), frozen_by = actor
    WHERE organization_id = org AND id = snapshot_id;
  RETURN snapshot_id;
END $$;
REVOKE ALL ON FUNCTION template_snapshot_from_draft(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION template_snapshot_from_draft(uuid, integer) TO sampleify_app;

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['templates', 'template_versions', 'template_sections', 'template_rows',
    'template_columns', 'template_fields', 'template_numeric_config', 'template_options',
    'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('ALTER POLICY definition_read ON %I USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
      (SELECT public.app_has_permission(''templates.read'') OR public.app_has_permission(''templates.manage'')
        OR public.app_has_permission(''datasheets.execute'') OR public.app_has_permission(''test_requests.allocate'')
        OR public.app_has_permission(''samples.manage'') OR public.app_has_permission(''samples.read'')))', relation);
  END LOOP;
END $$;

-- Position is historical data too: removal cannot rewrite an occurrence's old order.
CREATE FUNCTION template_guard_occurrence_position() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'Repeat occurrence positions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_occurrence_position_guard BEFORE UPDATE ON template_occurrences
  FOR EACH ROW EXECUTE FUNCTION template_guard_occurrence_position();
