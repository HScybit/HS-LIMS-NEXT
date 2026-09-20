-- Preserve the source request-screen state gate at the direct capture boundary.
CREATE OR REPLACE FUNCTION laboratory_capture_can_write() RETURNS boolean
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
      AND EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id = org AND id = sheet.test_request_id AND status IN ('allocated', 'in_progress', 'rejected'))
      AND EXISTS (SELECT 1 FROM public.test_request_assignments a JOIN public.memberships m
        ON m.organization_id = a.organization_id AND m.user_id = a.assigned_user_id JOIN public.users u ON u.id = m.user_id
        WHERE a.organization_id = org AND a.test_request_id = sheet.test_request_id AND a.assignment_type = 'analyst'
          AND a.assigned_user_id = actor AND a.unassigned_at IS NULL AND m.active AND u.active);
  END IF;
  RETURN capture.created_by = actor AND (public.app_has_permission('datasheets.execute')
    OR (capture.revision = 1 AND (public.app_has_permission('test_requests.allocate') OR public.app_has_permission('samples.manage'))));
END $$;

-- Display labels for actual recorded actors. Credentials/contact details remain
-- inaccessible, and an ID from another organization returns no row.
CREATE FUNCTION laboratory_actor_labels(actor_ids uuid[]) RETURNS TABLE(user_id uuid, display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT public.laboratory_can_read() THEN RAISE EXCEPTION 'Laboratory read permission required' USING ERRCODE = '42501'; END IF;
  IF actor_ids IS NULL OR cardinality(actor_ids) > 5000 OR array_position(actor_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid actor selection' USING ERRCODE = '23514';
  END IF;
  RETURN QUERY SELECT u.id, u.display_name FROM public.users u JOIN public.memberships m ON m.user_id = u.id
    WHERE m.organization_id = org AND u.id = ANY(actor_ids) ORDER BY u.id;
END $$;
REVOKE ALL ON FUNCTION laboratory_actor_labels(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_actor_labels(uuid[]) TO sampleify_app;
