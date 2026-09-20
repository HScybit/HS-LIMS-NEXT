-- The seed session has to be committed before the seeding work can use it on
-- another connection, so it is minted outside the caller's request
-- transaction. That connection carries no session context, so the platform
-- administrator check moves from the session GUC to the verified actor the
-- application passes in — the same trust boundary every other service call
-- uses, and the request transaction has already checked the GUC as well.
DROP FUNCTION IF EXISTS platform_create_seed_session(uuid, text, text);--> statement-breakpoint

CREATE FUNCTION platform_create_seed_session(
  actor_organization uuid, actor_user uuid, requested_organization uuid,
  requested_token_hash text, requested_csrf_hash text)
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE administrator uuid; credential public.credentials%ROWTYPE; expiry timestamptz;
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

  expiry := now() + interval '30 minutes';
  INSERT INTO public.sessions (organization_id, user_id, token_hash, csrf_hash, credential_revision, expires_at)
    VALUES (requested_organization, administrator, requested_token_hash, requested_csrf_hash, credential.revision, expiry);
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (administrator, requested_organization, 'sign_in');

  RETURN QUERY SELECT administrator, expiry;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_create_seed_session(uuid, uuid, uuid, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_create_seed_session(uuid, uuid, uuid, text, text) TO sampleify_app;
