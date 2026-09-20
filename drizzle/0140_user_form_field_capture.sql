ALTER TABLE "user_account_commands" ADD COLUMN "form_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD COLUMN "form_profile_revision" integer;--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD COLUMN "form_custom_field_revision" integer;--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD CONSTRAINT "user_account_form_profile_fk" FOREIGN KEY ("organization_id","user_id","form_profile_revision") REFERENCES "public"."user_profile_versions"("organization_id","user_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD CONSTRAINT "user_account_form_field_fk" FOREIGN KEY ("organization_id","user_id","form_custom_field_revision") REFERENCES "public"."user_field_value_versions"("organization_id","subject_user_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account_commands" ADD CONSTRAINT "user_account_form_shape" CHECK (("user_account_commands"."form_fingerprint" is null and num_nonnulls("user_account_commands"."form_profile_revision","user_account_commands"."form_custom_field_revision")=0)
    or ("user_account_commands"."form_fingerprint" is not null and octet_length("user_account_commands"."form_fingerprint")=32
      and ("user_account_commands"."form_profile_revision" is null or "user_account_commands"."form_profile_revision">0) and ("user_account_commands"."form_custom_field_revision" is null or "user_account_commands"."form_custom_field_revision">0)));
--> statement-breakpoint
CREATE FUNCTION users_prepare_field_form() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.users_require_manager();
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||nullif(current_setting('app.organization_id',true),'')::uuid::text,0));
  PERFORM public.users_require_manager();
END $$;
REVOKE ALL ON FUNCTION users_prepare_field_form() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_prepare_field_form() TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION users_assert_saved_field_uniqueness(target_organization uuid,target_user uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- Omission preserves the saved dictionary but source users.update validates its keys against current unique definitions.
  IF EXISTS (
    WITH incoming AS MATERIALIZED (
      SELECT saved_definition.key,
        public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text
      FROM public.memberships member JOIN public.user_version_custom_fields field
        ON field.organization_id=member.organization_id AND field.subject_user_id=member.user_id AND field.revision=member.custom_field_revision
      JOIN public.custom_field_versions saved_definition ON saved_definition.organization_id=field.organization_id
        AND saved_definition.field_id=field.field_id AND saved_definition.revision=field.field_revision
      JOIN public.custom_field_definitions current_definition ON current_definition.organization_id=field.organization_id
        AND current_definition.key=saved_definition.key AND current_definition.active AND current_definition.associated_with='users' AND current_definition.validate_uniqueness
      JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
        AND value.revision=field.revision AND value.field_id=field.field_id
      WHERE member.organization_id=target_organization AND member.user_id=target_user
    )
    SELECT 1 FROM incoming WHERE text IS NOT NULL GROUP BY key,text HAVING count(*)>1
    UNION ALL
    SELECT 1 FROM incoming
    JOIN public.custom_field_versions saved_definition ON saved_definition.organization_id=target_organization AND saved_definition.key=incoming.key
    JOIN public.user_version_custom_fields field ON field.organization_id=saved_definition.organization_id
      AND field.field_id=saved_definition.field_id AND field.field_revision=saved_definition.revision
    JOIN public.memberships member ON member.organization_id=field.organization_id AND member.user_id=field.subject_user_id AND member.custom_field_revision=field.revision
    JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
      AND value.revision=field.revision AND value.field_id=field.field_id AND value.raw_text IS NOT NULL
      AND md5(value.raw_text)=md5(incoming.text) AND value.raw_text=incoming.text
    WHERE incoming.text IS NOT NULL AND field.subject_user_id<>target_user
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
END $$;
REVOKE ALL ON FUNCTION users_assert_saved_field_uniqueness(uuid,uuid) FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_guard_account_command() RETURNS trigger
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
  IF (NEW.form_profile_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_profile_versions profile WHERE profile.organization_id=NEW.organization_id AND profile.user_id=NEW.user_id
      AND profile.revision=NEW.form_profile_revision AND profile.request_id=NEW.request_id AND profile.saved_by=NEW.saved_by
      AND profile.created_transaction_id=NEW.created_transaction_id
  )) OR (NEW.form_custom_field_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_field_value_versions capture WHERE capture.organization_id=NEW.organization_id AND capture.subject_user_id=NEW.user_id
      AND capture.revision=NEW.form_custom_field_revision AND capture.request_id=NEW.request_id AND capture.saved_by=NEW.saved_by
      AND capture.created_transaction_id=NEW.created_transaction_id
  )) THEN RAISE EXCEPTION 'Form versions must belong to the same actual command' USING ERRCODE='23514',CONSTRAINT='user_account_request_reused'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_require_account_result() RETURNS trigger
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
  IF (NEW.form_profile_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_profiles profile WHERE profile.organization_id=NEW.organization_id AND profile.user_id=NEW.user_id AND profile.revision=NEW.form_profile_revision
  )) OR (NEW.form_custom_field_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memberships member WHERE member.organization_id=NEW.organization_id AND member.user_id=NEW.user_id AND member.custom_field_revision=NEW.form_custom_field_revision
  )) THEN RAISE EXCEPTION 'Form command requires its complete profile and field result' USING ERRCODE='23514',CONSTRAINT='user_account_request_reused'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION users_write_account_command(target uuid,expected_revision integer,requested_id uuid,requested_fingerprint bytea,
  requested_username text,requested_email text,requested_name text,requested_password_hash text,
  requested_form_fingerprint bytea,requested_profile_revision integer,requested_custom_field_revision integer)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
  IF (requested_form_fingerprint IS NULL AND num_nonnulls(requested_profile_revision,requested_custom_field_revision)>0)
    OR (requested_form_fingerprint IS NOT NULL AND (octet_length(requested_form_fingerprint)<>32
      OR requested_profile_revision<=0 OR requested_custom_field_revision<=0)) THEN
    RAISE EXCEPTION 'Invalid form command' USING ERRCODE='23514',CONSTRAINT='user_account_form_invalid';
  END IF;
  IF requested_form_fingerprint IS NOT NULL THEN PERFORM public.users_prepare_field_form(); END IF;
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
    IF prior.form_fingerprint IS NOT NULL THEN
      IF (prior.form_fingerprint,prior.form_profile_revision,prior.form_custom_field_revision)
        IS DISTINCT FROM (requested_form_fingerprint,requested_profile_revision,requested_custom_field_revision) THEN
        RAISE EXCEPTION 'Save request already used for a different form' USING ERRCODE='23514',CONSTRAINT='user_account_request_reused';
      END IF;
    ELSIF requested_form_fingerprint IS NOT NULL THEN
      -- Legacy receipts have no invented form fingerprint; actual co-transaction history establishes profile presence.
      IF requested_custom_field_revision IS NOT NULL OR
        (requested_profile_revision IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.user_profile_versions profile WHERE profile.organization_id=org AND profile.user_id=target
            AND profile.request_id=requested_id AND profile.revision=requested_profile_revision AND profile.saved_by=actor
            AND profile.created_transaction_id=prior.created_transaction_id
        )) OR (requested_profile_revision IS NULL AND EXISTS (
          SELECT 1 FROM public.user_profile_versions profile WHERE profile.organization_id=org AND profile.user_id=target
            AND profile.request_id=requested_id AND profile.saved_by=actor AND profile.created_transaction_id=prior.created_transaction_id
        )) THEN RAISE EXCEPTION 'Save request already used for a different form' USING ERRCODE='23514',CONSTRAINT='user_account_request_reused'; END IF;
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
  IF requested_form_fingerprint IS NOT NULL AND requested_custom_field_revision IS NULL THEN
    PERFORM public.users_assert_saved_field_uniqueness(org,target);
  END IF;
  INSERT INTO public.user_account_commands(organization_id,user_id,request_id,fingerprint,revision,previous_revision,credential_revision,previous_credential_revision,
    password_changed,username,email,display_name,previous_username,previous_email,previous_display_name,saved_by,saved_by_username,saved_by_name,form_fingerprint,form_profile_revision,form_custom_field_revision)
    SELECT org,target,requested_id,requested_fingerprint,expected_revision+1,expected_revision,
      old_credential_revision+CASE WHEN requested_password_hash IS NOT NULL THEN 1 ELSE 0 END,old_credential_revision,
      requested_password_hash IS NOT NULL,requested_username,requested_email,requested_name,person.username,person.email,person.display_name,actor,editor.username,editor.display_name,requested_form_fingerprint,requested_profile_revision,requested_custom_field_revision
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
REVOKE ALL ON FUNCTION users_write_account_command(uuid,integer,uuid,bytea,text,text,text,text,bytea,integer,integer) FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_write_account(target uuid,expected_revision integer,requested_id uuid,requested_fingerprint bytea,
  requested_username text,requested_email text,requested_name text,requested_password_hash text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  RETURN public.users_write_account_command(target,expected_revision,requested_id,requested_fingerprint,requested_username,requested_email,requested_name,requested_password_hash,NULL,NULL,NULL);
END $$;
--> statement-breakpoint
CREATE FUNCTION users_write_form_account(target uuid,expected_revision integer,requested_id uuid,requested_fingerprint bytea,
  requested_username text,requested_email text,requested_name text,requested_password_hash text,
  requested_form_fingerprint bytea,requested_profile_revision integer,requested_custom_field_revision integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF requested_form_fingerprint IS NULL THEN RAISE EXCEPTION 'A form fingerprint is required' USING ERRCODE='23514',CONSTRAINT='user_account_form_invalid'; END IF;
  RETURN public.users_write_account_command(target,expected_revision,requested_id,requested_fingerprint,requested_username,requested_email,requested_name,requested_password_hash,requested_form_fingerprint,requested_profile_revision,requested_custom_field_revision);
END $$;
REVOKE ALL ON FUNCTION users_write_form_account(uuid,integer,uuid,bytea,text,text,text,text,bytea,integer,integer) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_write_form_account(uuid,integer,uuid,bytea,text,text,text,text,bytea,integer,integer) TO sampleify_app;
