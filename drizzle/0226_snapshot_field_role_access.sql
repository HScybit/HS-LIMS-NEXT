-- template_snapshot_from_draft() copies a fixed list of definition tables when freezing a
-- runtime snapshot from a draft; template_field_role_access (added in 0225) was missing from
-- that list, so a field's edit/view role restriction silently vanished the moment any sample,
-- test request or job actually ran against the template. CREATE OR REPLACE is safe here (same
-- signature, same grants) since only the body's copied-table list changes.
CREATE OR REPLACE FUNCTION public.template_snapshot_from_draft(source_id uuid, expected_revision integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  source public.template_versions; snapshot_id uuid; template_id uuid; relation text; column_names text;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT (
    public.app_has_permission('templates.manage') OR public.app_has_permission('test_requests.allocate')
    OR public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
    OR coalesce((SELECT v.template_id FROM public.template_versions v WHERE v.organization_id=org AND v.id=source_id)=public.laboratory_auto_job_template(),false)
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
    template_type, semantics, created_by, snapshot_source_id, snapshot_source_revision, header_document_id, footer_document_id, nabl_header_document_id, nabl_footer_document_id)
    SELECT org, source.template_id, coalesce(max(v.number), 0) + 1, 'building', source.name, source.description, source.kind,
      source.template_type, source.semantics, actor, source.id, source.revision, source.header_document_id, source.footer_document_id, source.nabl_header_document_id, source.nabl_footer_document_id
    FROM public.template_versions v WHERE v.organization_id = org AND v.template_id = source.template_id RETURNING id INTO snapshot_id;
  -- Only these definition tables are copied. Column identifiers come from PostgreSQL's
  -- catalog, never request data; new typed scalar columns are copied with their version.
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_repeat_groups',
    'template_fields', 'template_numeric_config', 'template_image_config', 'template_options', 'template_expressions', 'template_expression_references',
    'template_field_role_access'] LOOP
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
END $function$;
