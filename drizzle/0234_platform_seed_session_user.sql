-- Seeding a realistic laboratory means walking a sample through its lifecycle,
-- and the stages past allocation are not the administrator's to perform: only
-- the assigned analyst may submit a datasheet, and only the approver may grant
-- the final approval. The seed therefore needs a session per seeded user, not
-- just one for the organization's administrator.
--
-- `requested_user` selects whom the session belongs to. It must be an active
-- member of the organization being seeded; NULL keeps the previous behaviour of
-- choosing that organization's default administrator. Everything else is
-- unchanged: only a platform administrator may ask, the session lasts thirty
-- minutes, the sign-in is recorded, and any must_change_password flag is lifted
-- for the window and handed back so the caller can restore it.
DROP FUNCTION IF EXISTS platform_create_seed_session(uuid, uuid, uuid, text, text);--> statement-breakpoint

CREATE FUNCTION platform_create_seed_session(
  actor_organization uuid, actor_user uuid, requested_organization uuid,
  requested_token_hash text, requested_csrf_hash text, requested_user uuid DEFAULT NULL)
RETURNS TABLE (user_id uuid, expires_at timestamptz, restore_password_change boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE chosen uuid; credential public.credentials%ROWTYPE; expiry timestamptz; had_flag boolean;
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  JOIN public.memberships m ON m.organization_id = pa.organization_id AND m.user_id = pa.user_id AND m.active
  JOIN public.users u ON u.id = pa.user_id AND u.active
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  IF requested_user IS NULL THEN
    SELECT m.user_id INTO chosen
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id AND u.active
    JOIN public.organizations o ON o.id = m.organization_id AND o.active
    WHERE m.organization_id = requested_organization AND m.active
    ORDER BY m.is_default DESC, u.created_at, u.id
    LIMIT 1;
  ELSE
    -- Scoped deliberately: a platform administrator may seed as a member of the
    -- organization being seeded, and as nobody else.
    SELECT m.user_id INTO chosen
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id AND u.active
    JOIN public.organizations o ON o.id = m.organization_id AND o.active
    WHERE m.organization_id = requested_organization AND m.active AND m.user_id = requested_user;
  END IF;
  IF chosen IS NULL THEN RETURN; END IF;

  SELECT * INTO credential FROM public.credentials WHERE credentials.user_id = chosen FOR UPDATE;
  IF credential.revision IS NULL THEN RETURN; END IF;

  -- Capture the flag before lifting it so it can be put back exactly as it was.
  SELECT u.must_change_password INTO had_flag FROM public.users u WHERE u.id = chosen FOR UPDATE;
  UPDATE public.users SET must_change_password = false WHERE id = chosen;

  expiry := now() + interval '30 minutes';
  INSERT INTO public.sessions (organization_id, user_id, token_hash, csrf_hash, credential_revision, expires_at)
    VALUES (requested_organization, chosen, requested_token_hash, requested_csrf_hash, credential.revision, expiry);
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (chosen, requested_organization, 'sign_in');

  RETURN QUERY SELECT chosen, expiry, had_flag;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_create_seed_session(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_create_seed_session(uuid, uuid, uuid, text, text, uuid) TO sampleify_app;
