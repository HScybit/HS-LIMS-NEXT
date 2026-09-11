-- The runtime role never owns tables and cannot read credential/session tables.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, sampleify_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, sampleify_app;
GRANT USAGE ON SCHEMA public TO sampleify_app;
GRANT SELECT ON permissions TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION auth_reserve_attempt(requested_hash text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.login_limits AS limits (lookup_hash, attempts)
  VALUES (requested_hash, 1)
  ON CONFLICT (lookup_hash) DO UPDATE SET
    attempts = CASE WHEN limits.window_started_at <= now() - interval '15 minutes' THEN 1 ELSE least(limits.attempts + 1, 6) END,
    window_started_at = CASE WHEN limits.window_started_at <= now() - interval '15 minutes' THEN now() ELSE limits.window_started_at END
  RETURNING attempts <= 5
$$;
--> statement-breakpoint
CREATE FUNCTION auth_clear_attempts(requested_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.login_limits WHERE lookup_hash = requested_hash
$$;
--> statement-breakpoint
CREATE FUNCTION auth_login_principals(identifier text)
RETURNS TABLE (user_id uuid, organization_id uuid, password_hash text, encrypted_secret text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, chosen.organization_id, c.password_hash, CASE WHEN mfa.enabled THEN mfa.encrypted_secret ELSE NULL END
  FROM public.users u
  JOIN public.credentials c ON c.user_id = u.id
  LEFT JOIN public.user_mfa mfa ON mfa.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT m.organization_id FROM public.memberships m
    JOIN public.organizations o ON o.id = m.organization_id AND o.active
    WHERE m.user_id = u.id AND m.active
      AND (m.is_default OR 1 = (SELECT count(*) FROM public.memberships m2
        JOIN public.organizations o2 ON o2.id = m2.organization_id AND o2.active
        WHERE m2.user_id = u.id AND m2.active))
  ) chosen ON true
  WHERE u.active AND (lower(u.username) = lower(trim(identifier)) OR lower(u.email) = lower(trim(identifier)))
  ORDER BY u.id LIMIT 2
$$;
--> statement-breakpoint
CREATE FUNCTION auth_create_session(requested_user uuid, requested_organization uuid, expected_password text,
  expected_mfa_secret text, verified_step bigint, requested_token_hash text, requested_csrf_hash text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE credential public.credentials%ROWTYPE; mfa public.user_mfa%ROWTYPE; expiry timestamptz;
BEGIN
  PERFORM 1 FROM public.users WHERE id = requested_user AND active FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO credential FROM public.credentials WHERE user_id = requested_user FOR UPDATE;
  IF credential.password_hash IS DISTINCT FROM expected_password THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.memberships m JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = requested_user AND m.organization_id = requested_organization AND m.active AND o.active
    FOR SHARE OF m, o;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO mfa FROM public.user_mfa WHERE user_id = requested_user FOR UPDATE;
  IF coalesce(mfa.enabled, false) THEN
    IF mfa.encrypted_secret IS DISTINCT FROM expected_mfa_secret OR verified_step <= mfa.last_used_step
       OR verified_step NOT BETWEEN floor(extract(epoch FROM clock_timestamp()) / 30)::bigint - 1
                              AND floor(extract(epoch FROM clock_timestamp()) / 30)::bigint + 1 THEN
      RETURN NULL;
    END IF;
    UPDATE public.user_mfa SET last_used_step = verified_step WHERE user_id = requested_user;
  ELSIF expected_mfa_secret IS NOT NULL THEN RETURN NULL;
  END IF;
  UPDATE public.sessions SET revoked_at = now() WHERE id IN (
    SELECT id FROM public.sessions WHERE user_id = requested_user AND revoked_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC, id OFFSET 4
  );
  expiry := now() + interval '12 hours';
  INSERT INTO public.sessions (organization_id, user_id, token_hash, csrf_hash, credential_revision, expires_at)
    VALUES (requested_organization, requested_user, requested_token_hash, requested_csrf_hash, credential.revision, expiry);
  INSERT INTO public.account_events (user_id, organization_id, kind) VALUES (requested_user, requested_organization, 'sign_in');
  RETURN expiry;
END $$;
--> statement-breakpoint
-- Context is transaction-local and established from a live opaque session.
CREATE FUNCTION auth_session_context(requested_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, organization_id uuid, csrf_hash text,
  username text, email text, display_name text, organization_name text, must_change_password boolean,
  revision integer, mfa_enabled boolean, role_names text[], permission_codes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
      ON r.organization_id = mr.organization_id AND r.id = mr.role_id
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY r.name),
    ARRAY(SELECT DISTINCT rp.permission_code FROM public.membership_roles mr JOIN public.role_permissions rp
      ON rp.organization_id = mr.organization_id AND rp.role_id = mr.role_id
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY rp.permission_code)
  FROM public.sessions s JOIN public.users u ON u.id = s.user_id
  JOIN public.organizations o ON o.id = s.organization_id
  LEFT JOIN public.user_mfa mfa ON mfa.user_id = u.id
  WHERE s.token_hash = requested_hash;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_revoke_session() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected public.sessions%ROWTYPE;
BEGIN
  UPDATE public.sessions SET revoked_at = now()
    WHERE id = nullif(current_setting('app.session_id', true), '')::uuid AND revoked_at IS NULL
    RETURNING * INTO affected;
  IF FOUND THEN INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (affected.user_id, affected.organization_id, 'sign_out'); END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_own_credential() RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.password_hash FROM public.credentials c
  WHERE c.user_id = nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION auth_update_profile(requested_name text, requested_username text, expected_revision integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed_user uuid;
BEGIN
  UPDATE public.users SET display_name = trim(requested_name), username = trim(requested_username),
    revision = revision + 1, updated_at = now()
  WHERE id = nullif(current_setting('app.user_id', true), '')::uuid AND revision = expected_revision AND active
  RETURNING id INTO changed_user;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (changed_user, nullif(current_setting('app.organization_id', true), '')::uuid, 'profile_changed');
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_change_password(expected_hash text, new_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed_user uuid := nullif(current_setting('app.user_id', true), '')::uuid; new_revision integer;
BEGIN
  PERFORM 1 FROM public.users WHERE id = changed_user AND active FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.credentials SET password_hash = new_hash, revision = revision + 1, updated_at = now()
    WHERE user_id = changed_user AND password_hash = expected_hash RETURNING revision INTO new_revision;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.users SET must_change_password = false, updated_at = now(), revision = revision + 1 WHERE id = changed_user;
  UPDATE public.sessions SET revoked_at = now() WHERE user_id = changed_user
    AND id <> nullif(current_setting('app.session_id', true), '')::uuid AND revoked_at IS NULL;
  UPDATE public.sessions SET credential_revision = new_revision WHERE id = nullif(current_setting('app.session_id', true), '')::uuid;
  UPDATE public.password_resets SET used_at = now() WHERE user_id = changed_user AND used_at IS NULL;
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (changed_user, nullif(current_setting('app.organization_id', true), '')::uuid, 'password_changed');
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_request_reset(requested_email text, requested_hash text)
RETURNS TABLE (request_id uuid, recipient text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE found_user uuid; found_revision integer; new_id uuid;
BEGIN
  IF (SELECT count(*) FROM public.users WHERE lower(email) = lower(trim(requested_email)) AND active) <> 1 THEN RETURN; END IF;
  SELECT id INTO found_user FROM public.users WHERE lower(email) = lower(trim(requested_email)) AND active FOR UPDATE;
  SELECT revision INTO found_revision FROM public.credentials WHERE user_id = found_user FOR UPDATE;
  IF found_revision IS NULL THEN RETURN; END IF;
  UPDATE public.password_resets SET used_at = now() WHERE user_id = found_user AND used_at IS NULL;
  INSERT INTO public.password_resets (user_id, token_hash, credential_revision, expires_at)
    VALUES (found_user, requested_hash, found_revision, now() + interval '30 minutes') RETURNING id INTO new_id;
  RETURN QUERY SELECT new_id, u.email FROM public.users u WHERE u.id = found_user;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_complete_reset(requested_hash text, new_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE found_user uuid; reset_row public.password_resets%ROWTYPE; credential public.credentials%ROWTYPE;
BEGIN
  SELECT user_id INTO found_user FROM public.password_resets WHERE token_hash = requested_hash;
  IF found_user IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public.users WHERE id = found_user AND active FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO credential FROM public.credentials WHERE user_id = found_user FOR UPDATE;
  SELECT * INTO reset_row FROM public.password_resets WHERE token_hash = requested_hash FOR UPDATE;
  IF reset_row.used_at IS NOT NULL OR reset_row.expires_at <= now() OR reset_row.credential_revision <> credential.revision THEN RETURN false; END IF;
  UPDATE public.credentials SET password_hash = new_hash, revision = revision + 1, updated_at = now() WHERE user_id = found_user;
  UPDATE public.users SET must_change_password = false, updated_at = now(), revision = revision + 1 WHERE id = found_user;
  UPDATE public.sessions SET revoked_at = now() WHERE user_id = found_user AND revoked_at IS NULL;
  UPDATE public.password_resets SET used_at = now() WHERE user_id = found_user AND used_at IS NULL;
  INSERT INTO public.account_events (user_id, kind) VALUES (found_user, 'password_reset');
  RETURN true;
END $$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON organizations TO sampleify_app
  USING (id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_scope ON memberships TO sampleify_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_scope ON roles TO sampleify_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_scope ON membership_roles TO sampleify_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_scope ON role_permissions TO sampleify_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
GRANT SELECT ON organizations, memberships, roles, membership_roles, role_permissions TO sampleify_app;
--> statement-breakpoint
-- Every new function defaults to no public execution; grant only the named API.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_reserve_attempt(text), auth_clear_attempts(text), auth_login_principals(text),
  auth_create_session(uuid, uuid, text, text, bigint, text, text), auth_session_context(text), auth_revoke_session(),
  auth_own_credential(), auth_update_profile(text, text, integer), auth_change_password(text, text),
  auth_request_reset(text, text), auth_complete_reset(text, text) TO sampleify_app;
