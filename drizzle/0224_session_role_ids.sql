-- Template Studio parity, Phase 1 (schema/backend): per-field role-based edit/view
-- access needs the actual role IDs granted to the current session, not just their
-- flattened permission codes or display names (role_names) — a widget restricts
-- access to specific roles, and a role can grant the same permission code as
-- another role while still being a distinct, separately-targetable role. Adds
-- role_ids alongside the existing role_names, using the identical join shape.
DROP FUNCTION auth_session_context(text);
CREATE FUNCTION auth_session_context(requested_hash text)
 RETURNS TABLE(session_id uuid, user_id uuid, organization_id uuid, csrf_hash text, username text, email text, display_name text, organization_name text, must_change_password boolean, revision integer, mfa_enabled boolean, role_names text[], role_ids uuid[], permission_codes text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE found_user uuid; found_organization uuid;
BEGIN
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.organization_id', '', true);
  PERFORM set_config('app.session_id', '', true);
  SELECT s.user_id, s.organization_id INTO found_user, found_organization
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id AND u.active
  JOIN public.credentials c ON c.user_id = u.id AND c.revision = s.credential_revision
  JOIN public.memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id AND m.active
  JOIN public.organizations o ON o.id = s.organization_id AND o.active
  WHERE s.token_hash = requested_hash AND s.revoked_at IS NULL AND s.expires_at > now();
  IF found_user IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.user_id', found_user::text, true);
  PERFORM set_config('app.organization_id', found_organization::text, true);
  PERFORM set_config('app.session_id', (SELECT s.id::text FROM public.sessions s WHERE s.token_hash = requested_hash), true);
  RETURN QUERY SELECT s.id, u.id, o.id, s.csrf_hash, u.username, u.email, u.display_name, o.name,
    u.must_change_password, u.revision, coalesce(mfa.enabled, false),
    ARRAY(SELECT r.name FROM public.membership_roles mr JOIN public.roles r
      ON r.organization_id = mr.organization_id AND r.id = mr.role_id AND r.active
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY r.name),
    ARRAY(SELECT r.id FROM public.membership_roles mr JOIN public.roles r
      ON r.organization_id = mr.organization_id AND r.id = mr.role_id AND r.active
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY r.name),
    ARRAY(SELECT DISTINCT rp.permission_code FROM public.membership_roles mr JOIN public.role_permissions rp
      ON rp.organization_id = mr.organization_id AND rp.role_id = mr.role_id
      JOIN public.roles role ON role.organization_id=mr.organization_id AND role.id=mr.role_id AND role.active
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY rp.permission_code)
  FROM public.sessions s JOIN public.users u ON u.id = s.user_id
  JOIN public.organizations o ON o.id = s.organization_id
  LEFT JOIN public.user_mfa mfa ON mfa.user_id = u.id
  WHERE s.token_hash = requested_hash;
END $function$;
-- DROP FUNCTION discards existing grants along with the old signature; the app's
-- runtime role needs EXECUTE restored, same as every other session/auth function.
GRANT EXECUTE ON FUNCTION auth_session_context(text) TO sampleify_app;
