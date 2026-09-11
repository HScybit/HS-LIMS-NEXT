-- The capture ID is transaction-local context, like the authenticated tenant.
-- The predicate verifies that context against current assignments/status once
-- per statement; it does not trust it as proof of permission or cache user roles.
CREATE FUNCTION laboratory_capture_can_write() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  capture_id uuid := nullif(current_setting('app.capture_id', true), '')::uuid;
  capture public.template_instances; sheet public.datasheets;
BEGIN
  IF org IS NULL OR actor IS NULL OR capture_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id = org AND id = capture_id;
  IF capture.id IS NULL OR capture.status <> 'editing' THEN RETURN false; END IF;
  SELECT * INTO sheet FROM public.datasheets WHERE organization_id = org AND template_instance_id = capture_id;
  IF sheet.id IS NOT NULL THEN
    RETURN public.app_has_permission('datasheets.execute') AND sheet.status IN ('in_progress', 'rejected')
      AND EXISTS (SELECT 1 FROM public.test_request_assignments a JOIN public.memberships m
        ON m.organization_id = a.organization_id AND m.user_id = a.assigned_user_id
        JOIN public.users u ON u.id = m.user_id
        WHERE a.organization_id = org AND a.test_request_id = sheet.test_request_id AND a.assignment_type = 'analyst'
          AND a.assigned_user_id = actor AND a.unassigned_at IS NULL AND m.active AND u.active);
  END IF;
  -- An unbound capture can only be initialized by its creator. Normal standalone
  -- template verification captures remain editable by that creator/executor.
  RETURN capture.created_by = actor AND (public.app_has_permission('datasheets.execute')
    OR (capture.revision = 1 AND (public.app_has_permission('test_requests.allocate') OR public.app_has_permission('samples.manage'))));
END $$;
REVOKE ALL ON FUNCTION laboratory_capture_can_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_capture_can_write() TO sampleify_app;

DROP POLICY capture_scope ON template_instances;
CREATE POLICY capture_read ON template_instances FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT laboratory_can_read()));
CREATE POLICY capture_insert ON template_instances FOR INSERT TO sampleify_app WITH CHECK
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND created_by = nullif(current_setting('app.user_id', true), '')::uuid
    AND id = nullif(current_setting('app.capture_id', true), '')::uuid
    AND (SELECT app_has_permission('datasheets.execute') OR app_has_permission('test_requests.allocate') OR app_has_permission('samples.manage')));
CREATE POLICY capture_update ON template_instances FOR UPDATE TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND id = nullif(current_setting('app.capture_id', true), '')::uuid
    AND (SELECT laboratory_capture_can_write())) WITH CHECK
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND id = nullif(current_setting('app.capture_id', true), '')::uuid);
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_occurrences', 'template_values'] LOOP
    EXECUTE format('DROP POLICY capture_scope ON %I', relation);
    EXECUTE format('CREATE POLICY capture_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT laboratory_can_read()))', relation);
    EXECUTE format('CREATE POLICY capture_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND instance_id = nullif(current_setting(''app.capture_id'', true), '''')::uuid
        AND (SELECT laboratory_capture_can_write())) WITH CHECK
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND instance_id = nullif(current_setting(''app.capture_id'', true), '''')::uuid
        AND (SELECT laboratory_capture_can_write()))', relation);
  END LOOP;
END $$;

ALTER TABLE samples ADD CONSTRAINT sample_required_variant_details CHECK
  ((sample_type <> 'quality_control' OR iqc_type IS NOT NULL) AND (sample_type <> 'interlaboratory' OR ilc_mode IS NOT NULL));
