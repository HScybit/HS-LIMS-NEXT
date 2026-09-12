CREATE TABLE "user_mfa_setups" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"encrypted_secret" text NOT NULL,
	"credential_revision" integer NOT NULL,
	"mfa_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_mfa_setups_revisions" CHECK ("user_mfa_setups"."credential_revision" > 0 and "user_mfa_setups"."mfa_revision" >= 0),
	CONSTRAINT "user_mfa_setups_expiry" CHECK ("user_mfa_setups"."expires_at" > "user_mfa_setups"."created_at"),
	CONSTRAINT "user_mfa_setups_ciphertext" CHECK ("user_mfa_setups"."encrypted_secret" ~ '^[A-Za-z0-9_-]{60,220}$')
);
--> statement-breakpoint
ALTER TABLE "user_mfa" ALTER COLUMN "encrypted_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD COLUMN "change_id" uuid;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD COLUMN "change_session_id" uuid;--> statement-breakpoint
ALTER TABLE "user_mfa_setups" ADD CONSTRAINT "user_mfa_setups_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_setups_id_key" ON "user_mfa_setups" USING btree ("id");--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_change_session_id_sessions_id_fk" FOREIGN KEY ("change_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_revision_positive" CHECK ("user_mfa"."revision" > 0);--> statement-breakpoint
-- Disabled legacy setup ciphertext is no longer a credential. No history is fabricated.
UPDATE "user_mfa" SET "encrypted_secret" = NULL, "last_used_step" = -1 WHERE NOT "enabled";
--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_secret_state" CHECK (("user_mfa"."enabled" and "user_mfa"."encrypted_secret" is not null and "user_mfa"."last_used_step" >= -1) or (not "user_mfa"."enabled" and "user_mfa"."encrypted_secret" is null and "user_mfa"."last_used_step" = -1));--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_change_identity" CHECK (("user_mfa"."change_id" is null) = ("user_mfa"."change_session_id" is null));
--> statement-breakpoint
-- Credential and setup data remain private to the authentication functions.
REVOKE ALL ON user_mfa_setups FROM PUBLIC, sampleify_app, sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION auth_mfa_locked_session() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  account_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  account_organization uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  session_id uuid := nullif(current_setting('app.session_id', true), '')::uuid;
  account_credential_revision integer;
BEGIN
  -- Match sign-in/password-change lock order and revalidate after every wait.
  PERFORM 1 FROM public.users u WHERE u.id = account_id AND u.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active account' USING ERRCODE = '28000'; END IF;
  SELECT c.revision INTO account_credential_revision FROM public.credentials c WHERE c.user_id = account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active credential' USING ERRCODE = '28000'; END IF;
  PERFORM 1 FROM public.memberships m JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = account_id AND m.organization_id = account_organization AND m.active AND o.active FOR SHARE OF m, o;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active membership' USING ERRCODE = '28000'; END IF;
  PERFORM 1 FROM public.sessions s WHERE s.id = session_id AND s.user_id = account_id
    AND s.organization_id = account_organization AND s.credential_revision = account_credential_revision
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active session' USING ERRCODE = '28000'; END IF;
  RETURN session_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_mfa_state() RETURNS TABLE(enabled boolean, revision integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(m.enabled, false), coalesce(m.revision, 0)
  FROM public.users u LEFT JOIN public.user_mfa m ON m.user_id = u.id
  WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION auth_start_mfa_setup(candidate_secret text)
RETURNS TABLE(id uuid, encrypted_secret text, expires_at timestamptz, mfa_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  own_session uuid := public.auth_mfa_locked_session();
  account_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  current_revision integer;
  account_credential_revision integer;
  started_at timestamptz;
  expiry timestamptz;
BEGIN
  IF candidate_secret IS NULL OR candidate_secret !~ '^[A-Za-z0-9_-]{60,220}$' THEN
    RAISE EXCEPTION 'Invalid encrypted setup' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_mfa m WHERE m.user_id = account_id AND m.enabled) THEN RETURN; END IF;
  current_revision := coalesce((SELECT m.revision FROM public.user_mfa m WHERE m.user_id = account_id), 0);
  SELECT c.revision INTO account_credential_revision FROM public.credentials c WHERE c.user_id = account_id;
  DELETE FROM public.user_mfa_setups p USING public.sessions s WHERE s.id = p.session_id AND s.user_id = account_id
    AND (p.expires_at <= clock_timestamp() OR p.credential_revision <> account_credential_revision
      OR p.mfa_revision <> current_revision OR s.revoked_at IS NOT NULL OR s.expires_at <= clock_timestamp());
  IF NOT EXISTS (SELECT 1 FROM public.user_mfa_setups p WHERE p.session_id = own_session) THEN
    started_at := clock_timestamp();
    SELECT least(s.expires_at, started_at + interval '10 minutes') INTO expiry FROM public.sessions s WHERE s.id = own_session;
    IF expiry <= started_at THEN RAISE EXCEPTION 'No active session' USING ERRCODE = '28000'; END IF;
    INSERT INTO public.user_mfa_setups(session_id, encrypted_secret, credential_revision, mfa_revision, created_at, expires_at)
      VALUES (own_session, candidate_secret, account_credential_revision, current_revision, started_at, expiry);
  END IF;
  RETURN QUERY SELECT p.id, p.encrypted_secret, p.expires_at, p.mfa_revision
    FROM public.user_mfa_setups p WHERE p.session_id = own_session;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_cancel_mfa_setup(requested_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE own_session uuid := public.auth_mfa_locked_session();
BEGIN
  DELETE FROM public.user_mfa_setups p WHERE p.session_id = own_session AND p.id = requested_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_read_mfa_setup(requested_id uuid) RETURNS TABLE(encrypted_secret text, completed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  own_session uuid := public.auth_mfa_locked_session();
  account_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_mfa m WHERE m.user_id = account_id AND m.enabled
    AND m.change_id = requested_id AND m.change_session_id = own_session) THEN
    RETURN QUERY SELECT NULL::text, true;
    RETURN;
  END IF;
  RETURN QUERY SELECT p.encrypted_secret, false FROM public.user_mfa_setups p
    JOIN public.sessions s ON s.id = p.session_id
    JOIN public.credentials c ON c.user_id = s.user_id AND c.revision = p.credential_revision
    LEFT JOIN public.user_mfa m ON m.user_id = s.user_id
    WHERE p.session_id = own_session AND p.id = requested_id AND p.expires_at > clock_timestamp()
      AND NOT coalesce(m.enabled, false) AND p.mfa_revision = coalesce(m.revision, 0);
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_enable_mfa(requested_id uuid, expected_secret text, verified_step bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  own_session uuid := public.auth_mfa_locked_session();
  account_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  setup public.user_mfa_setups%ROWTYPE;
  mfa public.user_mfa%ROWTYPE;
  changed_revision integer;
BEGIN
  SELECT * INTO mfa FROM public.user_mfa m WHERE m.user_id = account_id;
  IF mfa.enabled AND mfa.change_id = requested_id AND mfa.change_session_id = own_session THEN RETURN mfa.revision; END IF;
  IF coalesce(mfa.enabled, false) THEN RETURN NULL; END IF;
  SELECT p.* INTO setup FROM public.user_mfa_setups p
    JOIN public.credentials c ON c.user_id = account_id AND c.revision = p.credential_revision
    WHERE p.session_id = own_session AND p.id = requested_id AND p.expires_at > clock_timestamp()
      AND p.mfa_revision = coalesce(mfa.revision, 0);
  IF NOT FOUND OR expected_secret IS NULL OR setup.encrypted_secret IS DISTINCT FROM expected_secret
    OR verified_step IS NULL OR verified_step NOT BETWEEN floor(extract(epoch FROM clock_timestamp()) / 30)::bigint - 1
      AND floor(extract(epoch FROM clock_timestamp()) / 30)::bigint + 1 THEN RETURN NULL; END IF;
  INSERT INTO public.user_mfa AS target(user_id, encrypted_secret, enabled, last_used_step, revision, change_id, change_session_id)
    VALUES (account_id, setup.encrypted_secret, true, verified_step, 1, requested_id, own_session)
    ON CONFLICT (user_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, enabled = true,
      last_used_step = excluded.last_used_step, revision = target.revision + 1,
      change_id = excluded.change_id, change_session_id = excluded.change_session_id
    RETURNING revision INTO changed_revision;
  DELETE FROM public.user_mfa_setups p USING public.sessions s WHERE s.id = p.session_id AND s.user_id = account_id;
  INSERT INTO public.account_events(user_id, organization_id, kind)
    VALUES (account_id, nullif(current_setting('app.organization_id', true), '')::uuid, 'mfa_enabled');
  RETURN changed_revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth_disable_mfa(expected_revision integer, requested_change uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  own_session uuid := public.auth_mfa_locked_session();
  account_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  mfa public.user_mfa%ROWTYPE;
  changed_revision integer;
BEGIN
  IF expected_revision IS NULL OR expected_revision < 0 OR requested_change IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO mfa FROM public.user_mfa m WHERE m.user_id = account_id;
  IF NOT mfa.enabled AND mfa.change_id = requested_change AND mfa.change_session_id = own_session THEN RETURN mfa.revision; END IF;
  IF coalesce(mfa.revision, 0) <> expected_revision THEN RETURN NULL; END IF;
  IF NOT coalesce(mfa.enabled, false) THEN RETURN coalesce(mfa.revision, 0); END IF;
  UPDATE public.user_mfa SET encrypted_secret = NULL, enabled = false, last_used_step = -1,
    revision = revision + 1, change_id = requested_change, change_session_id = own_session
    WHERE user_id = account_id RETURNING revision INTO changed_revision;
  DELETE FROM public.user_mfa_setups p USING public.sessions s WHERE s.id = p.session_id AND s.user_id = account_id;
  INSERT INTO public.account_events(user_id, organization_id, kind)
    VALUES (account_id, nullif(current_setting('app.organization_id', true), '')::uuid, 'mfa_disabled');
  RETURN changed_revision;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_mfa_locked_session(), auth_mfa_state(), auth_start_mfa_setup(text),
  auth_cancel_mfa_setup(uuid), auth_read_mfa_setup(uuid), auth_enable_mfa(uuid,text,bigint), auth_disable_mfa(integer,uuid)
  FROM PUBLIC, sampleify_app, sampleify_report_worker;
GRANT EXECUTE ON FUNCTION auth_mfa_state(), auth_start_mfa_setup(text), auth_cancel_mfa_setup(uuid),
  auth_read_mfa_setup(uuid), auth_enable_mfa(uuid,text,bigint), auth_disable_mfa(integer,uuid) TO sampleify_app;
