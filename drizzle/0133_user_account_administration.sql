CREATE TABLE "platform_administrators" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by" text NOT NULL,
	CONSTRAINT "platform_administrator_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "platform_administrator_operator" CHECK (length(trim("platform_administrators"."granted_by")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "user_account_commands" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" "bytea" NOT NULL,
	"revision" integer NOT NULL,
	"previous_revision" integer NOT NULL,
	"credential_revision" integer NOT NULL,
	"previous_credential_revision" integer NOT NULL,
	"password_changed" boolean NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"previous_username" text NOT NULL,
	"previous_email" text NOT NULL,
	"previous_display_name" text NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_by_username" text NOT NULL,
	"saved_by_name" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "user_account_request_pk" PRIMARY KEY("organization_id","request_id"),
	CONSTRAINT "user_account_revision_key" UNIQUE("user_id","revision"),
	CONSTRAINT "user_account_revisions" CHECK ("user_account_commands"."previous_revision">0 and "user_account_commands"."revision"="user_account_commands"."previous_revision"+1
    and "user_account_commands"."previous_credential_revision">0 and "user_account_commands"."credential_revision"="user_account_commands"."previous_credential_revision"+case when "user_account_commands"."password_changed" then 1 else 0 end),
	CONSTRAINT "user_account_identity" CHECK (octet_length("user_account_commands"."fingerprint")=32 and length(trim("user_account_commands"."username")) between 1 and 100
    and length(trim("user_account_commands"."email")) between 1 and 320 and length(trim("user_account_commands"."display_name")) between 1 and 200
    and length(trim("user_account_commands"."saved_by_username")) between 1 and 100 and length(trim("user_account_commands"."saved_by_name")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "platform_administrators" ADD CONSTRAINT "platform_administrators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_administrators" ADD CONSTRAINT "platform_administrator_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD CONSTRAINT "user_account_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD CONSTRAINT "user_account_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE platform_administrators ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_administrators,user_account_commands FROM PUBLIC,sampleify_app,sampleify_report_worker;

CREATE FUNCTION auth_is_platform_administrator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sessions session
    JOIN public.platform_administrators administrator ON administrator.organization_id=session.organization_id AND administrator.user_id=session.user_id
    JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
    JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
    JOIN public.memberships member ON member.organization_id=session.organization_id AND member.user_id=person.id AND member.active
    JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
    WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid
      AND session.user_id=nullif(current_setting('app.user_id',true),'')::uuid
      AND session.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  )
$$;
REVOKE ALL ON FUNCTION auth_is_platform_administrator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_is_platform_administrator() TO sampleify_app;

CREATE FUNCTION users_guard_account_command() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Account administration history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.saved_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.saved_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.users person JOIN public.credentials credential ON credential.user_id=person.id
      JOIN public.users actor ON actor.id=NEW.saved_by WHERE person.id=NEW.user_id
        AND (person.revision,person.username,person.email,person.display_name,credential.revision,actor.username,actor.display_name)
          IS NOT DISTINCT FROM (NEW.previous_revision,NEW.previous_username,NEW.previous_email,NEW.previous_display_name,NEW.previous_credential_revision,NEW.saved_by_username,NEW.saved_by_name)
    ) THEN RAISE EXCEPTION 'Account history requires the actual preceding identity and editor' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_account_command_guard BEFORE INSERT OR UPDATE OR DELETE ON user_account_commands FOR EACH ROW EXECUTE FUNCTION users_guard_account_command();

CREATE FUNCTION users_require_account_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users person JOIN public.credentials credential ON credential.user_id=person.id
    WHERE person.id=NEW.user_id AND (person.revision,person.username,person.email,person.display_name,credential.revision)
      IS NOT DISTINCT FROM (NEW.revision,NEW.username,NEW.email,NEW.display_name,NEW.credential_revision)
      AND (NOT NEW.password_changed OR (NOT person.must_change_password
        AND NOT EXISTS (SELECT 1 FROM public.sessions session WHERE session.user_id=person.id AND session.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.password_resets reset WHERE reset.user_id=person.id AND reset.used_at IS NULL)))
  ) THEN RAISE EXCEPTION 'Account command requires its complete identity and credential result' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER user_account_result_required AFTER INSERT ON user_account_commands DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_require_account_result();
REVOKE ALL ON FUNCTION users_guard_account_command(),users_require_account_result() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION users_write_account(target uuid,expected_revision integer,requested_id uuid,requested_fingerprint bytea,
  requested_username text,requested_email text,requested_name text,requested_password_hash text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid; prior public.user_account_commands;
  person public.users; old_credential_revision integer; changes_identity boolean;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 1 AND 2147483646 OR requested_id IS NULL
    OR requested_fingerprint IS NULL OR octet_length(requested_fingerprint)<>32
    OR requested_username IS NULL OR length(requested_username) NOT BETWEEN 1 AND 100 OR requested_username<>trim(requested_username)
    OR requested_name IS NULL OR length(requested_name) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name)
    OR requested_email IS NULL OR length(requested_email) NOT BETWEEN 1 AND 320 OR requested_email<>trim(requested_email)
    OR requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    OR (requested_password_hash IS NOT NULL AND requested_password_hash !~ '^scrypt[$]1[$]32768[$]8[$]1[$][A-Za-z0-9_-]{22}[$][A-Za-z0-9_-]{86}$') THEN
    RAISE EXCEPTION 'Invalid account command' USING ERRCODE='23514',CONSTRAINT='user_account_invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  -- A global user lock also serializes new memberships and platform grants through their user foreign keys.
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,target]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.credentials WHERE user_id=ANY(ARRAY[actor,target]) ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,target]) ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.user_account_commands WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.user_id,prior.saved_by,prior.previous_revision,prior.fingerprint,prior.username,prior.email,prior.display_name,prior.password_changed)
      IS DISTINCT FROM (target,actor,expected_revision,requested_fingerprint,requested_username,requested_email,requested_name,requested_password_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'Save request already used for a different account change' USING ERRCODE='23514',CONSTRAINT='user_account_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO person FROM public.users WHERE id=target;
  IF person.revision<>expected_revision THEN RAISE EXCEPTION 'Account changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='user_account_stale'; END IF;
  SELECT revision INTO old_credential_revision FROM public.credentials WHERE user_id=target;
  IF old_credential_revision IS NULL OR (requested_password_hash IS NOT NULL AND old_credential_revision=2147483647) THEN
    RAISE EXCEPTION 'Account credential is unavailable' USING ERRCODE='23514',CONSTRAINT='user_account_invalid_input';
  END IF;
  changes_identity:=(person.username,person.email,person.display_name) IS DISTINCT FROM (requested_username,requested_email,requested_name) OR requested_password_hash IS NOT NULL;
  IF changes_identity AND target<>actor THEN
    PERFORM 1 FROM public.platform_administrators WHERE (organization_id=org AND user_id=actor) OR user_id=target ORDER BY organization_id,user_id FOR SHARE;
    IF (EXISTS (SELECT 1 FROM public.memberships WHERE user_id=target AND organization_id<>org)
      OR EXISTS (SELECT 1 FROM public.platform_administrators WHERE user_id=target)) AND NOT public.auth_is_platform_administrator() THEN
      RAISE EXCEPTION 'Shared and platform identities require their owner or a platform administrator' USING ERRCODE='42501',CONSTRAINT='user_account_protected';
    END IF;
  END IF;
  -- Match creation and My Account ordering: organization/session locks precede alias locks.
  PERFORM public.auth_lock_login_aliases(ARRAY[requested_username,requested_email]);
  actor:=public.users_require_manager();
  IF requested_password_hash IS NOT NULL THEN
    PERFORM 1 FROM public.password_resets WHERE user_id=target AND used_at IS NULL ORDER BY id FOR UPDATE;
    PERFORM 1 FROM public.sessions WHERE user_id=target AND revoked_at IS NULL ORDER BY id FOR UPDATE;
    actor:=public.users_require_manager();
  END IF;
  IF (person.username IS DISTINCT FROM requested_username AND EXISTS (
      SELECT 1 FROM public.users WHERE id<>target AND (lower(username)=lower(requested_username) OR lower(email)=lower(requested_username))))
    OR (person.email IS DISTINCT FROM requested_email AND EXISTS (
      SELECT 1 FROM public.users WHERE id<>target AND (lower(username)=lower(requested_email) OR lower(email)=lower(requested_email)))) THEN
    RAISE EXCEPTION 'Username or email conflicts with a sign-in identifier' USING ERRCODE='23505',CONSTRAINT='user_account_identifier_taken';
  END IF;
  INSERT INTO public.user_account_commands(organization_id,user_id,request_id,fingerprint,revision,previous_revision,credential_revision,previous_credential_revision,
    password_changed,username,email,display_name,previous_username,previous_email,previous_display_name,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,requested_id,requested_fingerprint,expected_revision+1,expected_revision,
      old_credential_revision+CASE WHEN requested_password_hash IS NOT NULL THEN 1 ELSE 0 END,old_credential_revision,
      requested_password_hash IS NOT NULL,requested_username,requested_email,requested_name,person.username,person.email,person.display_name,actor,editor.username,editor.display_name
    FROM public.users editor WHERE editor.id=actor;
  UPDATE public.users SET username=requested_username,email=requested_email,display_name=requested_name,revision=expected_revision+1,updated_at=transaction_timestamp(),
    must_change_password=CASE WHEN requested_password_hash IS NOT NULL THEN false ELSE must_change_password END WHERE id=target;
  IF requested_password_hash IS NOT NULL THEN
    UPDATE public.credentials SET password_hash=requested_password_hash,revision=old_credential_revision+1,updated_at=transaction_timestamp() WHERE user_id=target;
    UPDATE public.password_resets SET used_at=transaction_timestamp() WHERE user_id=target AND used_at IS NULL;
    UPDATE public.sessions SET revoked_at=transaction_timestamp() WHERE user_id=target AND revoked_at IS NULL;
  END IF;
  RETURN expected_revision+1;
END $$;
REVOKE ALL ON FUNCTION users_write_account(uuid,integer,uuid,bytea,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_write_account(uuid,integer,uuid,bytea,text,text,text,text) TO sampleify_app;
--> statement-breakpoint
CREATE VIEW user_account_heads WITH (security_barrier=true,security_invoker=false) AS
  SELECT membership.organization_id,person.id,person.revision,person.username,person.email,person.display_name,
    public.app_has_permission('users.manage') AND (person.id=nullif(current_setting('app.user_id',true),'')::uuid
      OR public.auth_is_platform_administrator() OR (NOT EXISTS (SELECT 1 FROM public.memberships other WHERE other.user_id=person.id AND other.organization_id<>membership.organization_id)
        AND NOT EXISTS (SELECT 1 FROM public.platform_administrators administrator WHERE administrator.user_id=person.id))) AS can_edit_identity
  FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
  WHERE membership.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_account_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,user_id,revision,previous_revision,username,email,display_name,previous_username,previous_email,previous_display_name,
    password_changed,saved_by,saved_by_username,saved_by_name,saved_at FROM public.user_account_commands
  WHERE organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON user_account_heads,user_account_history FROM PUBLIC;
GRANT SELECT ON user_account_heads,user_account_history TO sampleify_app;
