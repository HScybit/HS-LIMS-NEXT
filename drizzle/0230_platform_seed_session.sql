-- Seeding an organization runs through the real service layer, which means the
-- work has to be done as that organization's own administrator: row-level
-- security is driven by the session context. The application role has no access
-- to users, credentials or sessions, so minting that session stays inside a
-- SECURITY DEFINER function, which never exposes the stored credential.
--
-- Only a platform administrator may call it, the session is deliberately
-- short-lived, and every use is recorded in seed_runs against the administrator
-- who triggered it. MFA is not challenged here: the caller already holds a
-- higher privilege than the account being seeded as.
CREATE FUNCTION platform_create_seed_session(requested_organization uuid, requested_token_hash text, requested_csrf_hash text)
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE administrator uuid; credential public.credentials%ROWTYPE; expiry timestamptz;
BEGIN
  IF NOT public.auth_is_platform_administrator() THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  SELECT m.user_id INTO administrator
  FROM public.memberships m
  JOIN public.users u ON u.id = m.user_id AND u.active
  JOIN public.organizations o ON o.id = m.organization_id AND o.active
  WHERE m.organization_id = requested_organization AND m.active
  ORDER BY m.is_default DESC, u.created_at, u.id
  LIMIT 1;
  IF administrator IS NULL THEN RETURN; END IF;

  SELECT * INTO credential FROM public.credentials WHERE credentials.user_id = administrator FOR UPDATE;
  IF credential.revision IS NULL THEN RETURN; END IF;

  expiry := now() + interval '30 minutes';
  INSERT INTO public.sessions (organization_id, user_id, token_hash, csrf_hash, credential_revision, expires_at)
    VALUES (requested_organization, administrator, requested_token_hash, requested_csrf_hash, credential.revision, expiry);
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (administrator, requested_organization, 'sign_in');

  RETURN QUERY SELECT administrator, expiry;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_create_seed_session(uuid, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_create_seed_session(uuid, text, text) TO sampleify_app;
