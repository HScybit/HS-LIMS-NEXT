-- A platform administrator supporting several organizations needs to find a
-- user wherever they are, and to put a new password on an account when
-- somebody is locked out. Both are exposed only as SECURITY DEFINER functions,
-- because the application role has no table access to users, credentials,
-- sessions or account_events at all.

-- account_events records what happened to an account but not who caused it.
-- That is enough while a person only ever acts on their own account, and not
-- enough once an administrator can act on someone else's. Both columns are
-- nullable and move together: NULL means the account holder acted, as every
-- row written until now did.
ALTER TABLE account_events
  ADD COLUMN actor_user_id uuid REFERENCES users(id),
  ADD COLUMN actor_organization_id uuid REFERENCES organizations(id);--> statement-breakpoint

ALTER TABLE account_events
  ADD CONSTRAINT account_event_actor CHECK (num_nonnulls(actor_user_id, actor_organization_id) <> 1);--> statement-breakpoint

-- Reads the directory across every organization. Deliberately returns no
-- password hash and no MFA secret; whether MFA is on is a support question,
-- what the secret is never is.
CREATE FUNCTION platform_list_users(
  actor_organization uuid, actor_user uuid, requested_search text DEFAULT '',
  requested_page integer DEFAULT 1, requested_page_size integer DEFAULT 25)
RETURNS TABLE (
  user_id uuid, username text, email text, display_name text, active boolean,
  must_change_password boolean, mfa_enabled boolean, is_platform_administrator boolean,
  organization_id uuid, organization_code text, organization_name text,
  organization_count integer, last_sign_in_at timestamptz, total_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE pattern text; size integer; offset_rows integer;
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  JOIN public.memberships m ON m.organization_id = pa.organization_id AND m.user_id = pa.user_id AND m.active
  JOIN public.users u ON u.id = pa.user_id AND u.active
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  size := least(greatest(coalesce(requested_page_size, 25), 1), 100);
  offset_rows := (least(greatest(coalesce(requested_page, 1), 1), 1000000) - 1) * size;
  pattern := '%' || replace(replace(replace(coalesce(requested_search, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  WITH home AS (
    SELECT DISTINCT ON (m.user_id) m.user_id, m.organization_id
    FROM public.memberships m
    ORDER BY m.user_id, m.is_default DESC, m.created_at, m.organization_id
  ), matched AS (
    SELECT u.id, u.username, u.email, u.display_name, u.active, u.must_change_password,
      coalesce(mfa.enabled, false) AS mfa_enabled,
      EXISTS (SELECT 1 FROM public.platform_administrators pa WHERE pa.user_id = u.id) AS is_platform_administrator,
      o.id AS organization_id, o.code AS organization_code, o.name AS organization_name,
      (SELECT count(*)::integer FROM public.memberships m WHERE m.user_id = u.id) AS organization_count,
      (SELECT max(e.occurred_at) FROM public.account_events e WHERE e.user_id = u.id AND e.kind = 'sign_in') AS last_sign_in_at
    FROM public.users u
    LEFT JOIN home ON home.user_id = u.id
    LEFT JOIN public.organizations o ON o.id = home.organization_id
    LEFT JOIN public.user_mfa mfa ON mfa.user_id = u.id
    WHERE requested_search IS NULL OR requested_search = '' OR (
      u.username ILIKE pattern ESCAPE '\' OR u.email ILIKE pattern ESCAPE '\' OR u.display_name ILIKE pattern ESCAPE '\'
      OR o.code ILIKE pattern ESCAPE '\' OR o.name ILIKE pattern ESCAPE '\')
  )
  SELECT matched.id, matched.username, matched.email, matched.display_name, matched.active,
    matched.must_change_password, matched.mfa_enabled, matched.is_platform_administrator,
    matched.organization_id, matched.organization_code, matched.organization_name,
    matched.organization_count, matched.last_sign_in_at,
    (SELECT count(*)::integer FROM matched)
  FROM matched
  ORDER BY matched.organization_name NULLS LAST, matched.username
  LIMIT size OFFSET offset_rows;
END $$;--> statement-breakpoint

-- Puts a new password on an account. Every session the user holds is revoked
-- immediately through the credential revision the session was issued against,
-- any pending self-service reset is spent, and the account must choose its own
-- password at the next sign-in. The administrator who did it is recorded.
CREATE FUNCTION platform_reset_user_password(
  actor_organization uuid, actor_user uuid, target_user uuid, new_hash text)
RETURNS TABLE (username text, display_name text, organization_code text, sessions_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE account public.users%ROWTYPE; home_organization uuid; home_code text; revoked integer;
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  JOIN public.memberships m ON m.organization_id = pa.organization_id AND m.user_id = pa.user_id AND m.active
  JOIN public.users u ON u.id = pa.user_id AND u.active
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  IF new_hash IS NULL OR length(new_hash) < 1 THEN
    RAISE EXCEPTION 'a password hash is required'
      USING ERRCODE = 'invalid_parameter_value', CONSTRAINT = 'platform_password_hash_required';
  END IF;

  SELECT * INTO account FROM public.users WHERE id = target_user FOR UPDATE;
  IF account.id IS NULL THEN
    RAISE EXCEPTION 'user was not found'
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'platform_user_not_found';
  END IF;

  SELECT m.organization_id INTO home_organization FROM public.memberships m
  WHERE m.user_id = target_user ORDER BY m.is_default DESC, m.created_at, m.organization_id LIMIT 1;
  SELECT o.code INTO home_code FROM public.organizations o WHERE o.id = home_organization;

  UPDATE public.credentials SET password_hash = new_hash, revision = revision + 1, updated_at = now()
    WHERE credentials.user_id = target_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this account has no credential to reset'
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'platform_credential_not_found';
  END IF;

  UPDATE public.users SET must_change_password = true, updated_at = now(), revision = revision + 1
    WHERE id = target_user;

  WITH revoked_sessions AS (
    UPDATE public.sessions SET revoked_at = now()
    WHERE sessions.user_id = target_user AND revoked_at IS NULL RETURNING 1)
  SELECT count(*)::integer INTO revoked FROM revoked_sessions;

  UPDATE public.password_resets SET used_at = now()
    WHERE password_resets.user_id = target_user AND used_at IS NULL;

  INSERT INTO public.account_events (user_id, organization_id, kind, actor_user_id, actor_organization_id)
    VALUES (target_user, home_organization, 'password_reset', actor_user, actor_organization);

  RETURN QUERY SELECT account.username, account.display_name, home_code, revoked;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_list_users(uuid, uuid, text, integer, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_reset_user_password(uuid, uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_list_users(uuid, uuid, text, integer, integer) TO sampleify_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_reset_user_password(uuid, uuid, uuid, text) TO sampleify_app;
