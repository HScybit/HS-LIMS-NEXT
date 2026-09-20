-- A newly provisioned administrator must change their password before they can
-- manage users, which is enforced in the database by users_directory_organization()
-- and sixteen sibling guards. Seeding runs as that administrator, so the flag has
-- to be lifted for the provisioning window and put back afterwards. Both halves
-- live in SECURITY DEFINER functions so the flag is never writable by the
-- application role, and the paired call restores whatever the flag had been.
DROP FUNCTION IF EXISTS platform_create_seed_session(uuid, uuid, uuid, text, text);--> statement-breakpoint

CREATE FUNCTION platform_create_seed_session(
  actor_organization uuid, actor_user uuid, requested_organization uuid,
  requested_token_hash text, requested_csrf_hash text)
RETURNS TABLE (user_id uuid, expires_at timestamptz, restore_password_change boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE administrator uuid; credential public.credentials%ROWTYPE; expiry timestamptz; had_flag boolean;
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  JOIN public.memberships m ON m.organization_id = pa.organization_id AND m.user_id = pa.user_id AND m.active
  JOIN public.users u ON u.id = pa.user_id AND u.active
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
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

  -- Capture the flag before lifting it so it can be put back exactly as it was.
  SELECT u.must_change_password INTO had_flag FROM public.users u WHERE u.id = administrator FOR UPDATE;
  UPDATE public.users SET must_change_password = false WHERE id = administrator;

  expiry := now() + interval '30 minutes';
  INSERT INTO public.sessions (organization_id, user_id, token_hash, csrf_hash, credential_revision, expires_at)
    VALUES (requested_organization, administrator, requested_token_hash, requested_csrf_hash, credential.revision, expiry);
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (administrator, requested_organization, 'sign_in');

  RETURN QUERY SELECT administrator, expiry, had_flag;
END $$;--> statement-breakpoint

CREATE FUNCTION platform_end_seed_session(
  actor_organization uuid, actor_user uuid, seeded_user uuid,
  requested_token_hash text, restore_password_change boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  UPDATE public.sessions SET revoked_at = now()
    WHERE token_hash = requested_token_hash AND revoked_at IS NULL;
  IF restore_password_change THEN
    UPDATE public.users SET must_change_password = true WHERE id = seeded_user;
  END IF;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_create_seed_session(uuid, uuid, uuid, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_end_seed_session(uuid, uuid, uuid, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_create_seed_session(uuid, uuid, uuid, text, text) TO sampleify_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_end_seed_session(uuid, uuid, uuid, text, boolean) TO sampleify_app;
