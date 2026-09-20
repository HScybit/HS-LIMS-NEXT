-- A username edit must not make another account's email sign-in ambiguous.
-- Email is immutable through the self-service API; future administration must
-- enforce the same identifier boundary when adding or changing login aliases.
CREATE OR REPLACE FUNCTION auth_update_profile(requested_name text, requested_username text, expected_revision integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE id <> changed_user AND lower(email) = lower(trim(requested_username))) THEN
    RAISE EXCEPTION 'Username conflicts with an existing sign-in identifier' USING ERRCODE = '23505';
  END IF;
  UPDATE public.users SET display_name = trim(requested_name), username = trim(requested_username),
    revision = revision + 1, updated_at = now()
  WHERE id = changed_user AND revision = expected_revision AND active;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.account_events (user_id, organization_id, kind)
    VALUES (changed_user, nullif(current_setting('app.organization_id', true), '')::uuid, 'profile_changed');
  RETURN true;
END $$;
