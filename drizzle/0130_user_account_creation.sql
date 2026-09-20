CREATE TABLE "user_creation_commands" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" "bytea" NOT NULL,
	"profile_revision" integer NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "user_creation_request_pk" PRIMARY KEY("organization_id","request_id"),
	CONSTRAINT "user_creation_identity_key" UNIQUE("user_id"),
	CONSTRAINT "user_creation_fields" CHECK (octet_length("user_creation_commands"."fingerprint")=32 and "user_creation_commands"."profile_revision"=1
    and length(trim("user_creation_commands"."username")) between 1 and 100 and length(trim("user_creation_commands"."email")) between 1 and 320
    and length(trim("user_creation_commands"."display_name")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "user_creation_commands" ADD CONSTRAINT "user_creation_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_creation_commands" ADD CONSTRAINT "user_creation_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_creation_commands" ADD CONSTRAINT "user_creation_profile_fk" FOREIGN KEY ("organization_id","user_id","profile_revision") REFERENCES "public"."user_profile_versions"("organization_id","user_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_creation_commands" ADD CONSTRAINT "user_creation_actor_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Native writes coordinate aliases; owner-only offline imports may retain observed legacy ambiguities.
CREATE FUNCTION auth_lock_login_aliases(aliases text[]) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE alias text;
BEGIN
  IF aliases IS NULL OR array_ndims(aliases) IS DISTINCT FROM 1 OR cardinality(aliases) NOT BETWEEN 1 AND 2
    OR EXISTS (SELECT 1 FROM unnest(aliases) value WHERE value IS NULL OR length(trim(value)) NOT BETWEEN 1 AND 320) THEN
    RAISE EXCEPTION 'Invalid login aliases' USING ERRCODE='22023';
  END IF;
  FOR alias IN SELECT DISTINCT lower(trim(value)) FROM unnest(aliases) value ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtext('sampleify_login_alias'),hashtext(alias));
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION auth_lock_login_aliases(text[]) FROM PUBLIC;

-- Keep My Account username edits in the same alias protocol as administrative creation.
CREATE OR REPLACE FUNCTION auth_update_profile(requested_name text,requested_username text,expected_revision integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed_user uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  PERFORM public.auth_mfa_locked_session();
  PERFORM public.auth_lock_login_aliases(ARRAY[requested_username]);
  PERFORM public.auth_mfa_locked_session();
  IF EXISTS (SELECT 1 FROM public.users WHERE id<>changed_user AND lower(email)=lower(trim(requested_username))) THEN
    RAISE EXCEPTION 'Username conflicts with an existing sign-in identifier' USING ERRCODE='23505';
  END IF;
  UPDATE public.users SET display_name=trim(requested_name),username=trim(requested_username),revision=revision+1,updated_at=now()
    WHERE id=changed_user AND revision=expected_revision AND active;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.account_events(user_id,organization_id,kind)
    VALUES(changed_user,nullif(current_setting('app.organization_id',true),'')::uuid,'profile_changed');
  RETURN true;
END $$;

CREATE FUNCTION users_guard_creation_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Account creation history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.created_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.created_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.users person JOIN public.credentials credential ON credential.user_id=person.id
      JOIN public.memberships membership ON membership.user_id=person.id AND membership.organization_id=NEW.organization_id
      JOIN public.user_profile_versions profile ON profile.organization_id=membership.organization_id AND profile.user_id=person.id AND profile.revision=1
      WHERE person.id=NEW.user_id AND person.active AND NOT person.must_change_password AND person.revision=1
        AND membership.active AND membership.is_default AND credential.revision=1
        AND person.created_at=transaction_timestamp() AND membership.created_at=transaction_timestamp() AND credential.updated_at=transaction_timestamp()
        AND profile.saved_by=NEW.created_by AND profile.saved_at=transaction_timestamp() AND profile.created_transaction_id=pg_current_xact_id()
        AND profile.request_id=NEW.request_id AND profile.previous_revision IS NULL
        AND (person.username,person.email,person.display_name) IS NOT DISTINCT FROM (NEW.username,NEW.email,NEW.display_name)
    ) THEN RAISE EXCEPTION 'Creation history requires the actual new account, profile and creator transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_creation_history_guard BEFORE INSERT OR UPDATE OR DELETE ON user_creation_commands FOR EACH ROW EXECUTE FUNCTION users_guard_creation_history();
ALTER TABLE user_creation_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_creation_commands FROM PUBLIC,sampleify_app,sampleify_report_worker;
REVOKE ALL ON FUNCTION users_guard_creation_history() FROM PUBLIC;

CREATE FUNCTION users_create_account(target uuid,requested_id uuid,requested_fingerprint bytea,requested_username text,requested_email text,requested_name text,requested_password_hash text,
  employee_code_value text,employee_code_provided boolean,phone_value text,phone_provided boolean,designation_value text,designation_provided boolean,
  can_manage_value boolean,can_manage_provided boolean,unit_value uuid,unit_provided boolean,default_role_value uuid,laboratory_value uuid,manager_value uuid,manager_provided boolean,selected_roles uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; prior public.user_creation_commands; saved_revision integer;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR requested_id IS NULL OR requested_fingerprint IS NULL OR octet_length(requested_fingerprint)<>32
    OR requested_username IS NULL OR length(requested_username) NOT BETWEEN 1 AND 100 OR requested_username<>trim(requested_username)
    OR requested_name IS NULL OR length(requested_name) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name)
    OR requested_email IS NULL OR length(requested_email) NOT BETWEEN 1 AND 320 OR requested_email<>trim(requested_email)
    OR requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    OR requested_password_hash IS NULL OR requested_password_hash !~ '^scrypt[$]1[$]32768[$]8[$]1[$][A-Za-z0-9_-]{22}[$][A-Za-z0-9_-]{86}$'
    OR default_role_value IS NULL OR laboratory_value IS NULL THEN
    RAISE EXCEPTION 'Invalid new account' USING ERRCODE='23514',CONSTRAINT='user_creation_invalid_input';
  END IF;
  IF manager_value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=manager_value) THEN
    RAISE EXCEPTION 'Reporting manager is unavailable' USING ERRCODE='23514',CONSTRAINT='user_profile_manager_unavailable';
  END IF;
  -- The target does not exist for a new creation. Lock all existing observed identities before the organization.
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,manager_value]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,manager_value]) ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.user_creation_commands WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF prior.user_id<>target OR prior.created_by<>actor OR prior.fingerprint<>requested_fingerprint
      OR (prior.username,prior.email,prior.display_name) IS DISTINCT FROM (requested_username,requested_email,requested_name) THEN
      RAISE EXCEPTION 'Creation request already used for a different account' USING ERRCODE='23514',CONSTRAINT='user_creation_request_reused';
    END IF;
    RETURN prior.profile_revision;
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE id=target) THEN
    RAISE EXCEPTION 'Account identity already exists' USING ERRCODE='23514',CONSTRAINT='user_creation_identity_exists';
  END IF;
  PERFORM public.auth_lock_login_aliases(ARRAY[requested_username,requested_email]);
  actor:=public.users_require_manager();
  IF EXISTS (SELECT 1 FROM public.users WHERE lower(username)=ANY(ARRAY[lower(requested_username),lower(requested_email)])
    OR lower(email)=ANY(ARRAY[lower(requested_username),lower(requested_email)])) THEN
    RAISE EXCEPTION 'A sign-in identifier is already in use' USING ERRCODE='23514',CONSTRAINT='user_creation_identifier_taken';
  END IF;
  INSERT INTO public.users(id,username,email,display_name) VALUES(target,requested_username,requested_email,requested_name);
  INSERT INTO public.credentials(user_id,password_hash) VALUES(target,requested_password_hash);
  INSERT INTO public.memberships(organization_id,user_id,is_default) VALUES(org,target,true);
  saved_revision:=public.users_write_profile(target,0,requested_id,employee_code_value,employee_code_provided,phone_value,phone_provided,
    designation_value,designation_provided,can_manage_value,can_manage_provided,unit_value,unit_provided,default_role_value,true,laboratory_value,true,manager_value,manager_provided,selected_roles);
  INSERT INTO public.user_creation_commands(organization_id,user_id,request_id,fingerprint,profile_revision,username,email,display_name,created_by)
    VALUES(org,target,requested_id,requested_fingerprint,saved_revision,requested_username,requested_email,requested_name,actor);
  RETURN saved_revision;
END $$;
REVOKE ALL ON FUNCTION users_create_account(uuid,uuid,bytea,text,text,text,text,text,boolean,text,boolean,text,boolean,boolean,boolean,uuid,boolean,uuid,uuid,uuid,boolean,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_create_account(uuid,uuid,bytea,text,text,text,text,text,boolean,text,boolean,text,boolean,boolean,boolean,uuid,boolean,uuid,uuid,uuid,boolean,uuid[]) TO sampleify_app;
