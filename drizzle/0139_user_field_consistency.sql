CREATE INDEX "custom_field_version_key_lookup" ON "custom_field_versions" USING btree ("organization_id","key","field_id","revision");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_begin_field_capture(target uuid,expected_revision integer,requested_id uuid,requested_count integer,requested_zone text)
RETURNS TABLE(saved_revision integer,replayed boolean,previous_field_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid; prior public.user_field_value_versions;
  head_revision integer; old_count integer:=0; definition_count integer;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR requested_id IS NULL
    OR requested_count IS NULL OR requested_count NOT BETWEEN 0 AND 500
    OR (requested_zone IS NOT NULL AND (requested_count=0 OR length(requested_zone) NOT BETWEEN 1 AND 100)) THEN
    RAISE EXCEPTION 'Invalid user field capture' USING ERRCODE='23514',CONSTRAINT='user_custom_field_invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  -- Definition writers hold their advisory lock before acquiring organization foreign-key locks.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
  actor:=public.users_require_manager();
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,target]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,target]) ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.user_field_value_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.subject_user_id,prior.saved_by,prior.previous_revision,prior.custom_field_count,prior.time_zone)
      IS DISTINCT FROM (target,actor,expected_revision,requested_count,requested_zone) THEN
      RAISE EXCEPTION 'Save request already used for another capture' USING ERRCODE='23514',CONSTRAINT='user_custom_field_request_reused';
    END IF;
    -- The service compares the complete immutable raw values before accepting a replay.
    RETURN QUERY SELECT prior.revision,true,NULL::integer; RETURN;
  END IF;
  SELECT custom_field_revision INTO head_revision FROM public.memberships WHERE organization_id=org AND user_id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found'; END IF;
  IF head_revision<>expected_revision THEN
    RAISE EXCEPTION 'User fields changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='user_custom_field_stale';
  END IF;
  IF head_revision>0 THEN
    SELECT custom_field_count INTO old_count FROM public.user_field_value_versions WHERE organization_id=org AND subject_user_id=target AND revision=head_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'User field history is missing' USING ERRCODE='23514',CONSTRAINT='user_custom_field_complete'; END IF;
    PERFORM public.users_assert_custom_fields(org,target,head_revision);
  END IF;
  SELECT count(*) INTO definition_count FROM public.custom_field_definitions WHERE organization_id=org AND active AND associated_with='users';
  IF definition_count>500 THEN RAISE EXCEPTION 'This form supports at most 500 Custom Fields' USING ERRCODE='23514',CONSTRAINT='user_custom_field_limit'; END IF;
  IF definition_count<>requested_count THEN
    RAISE EXCEPTION 'Provide the current user Custom Fields' USING ERRCODE='23514',CONSTRAINT='user_custom_field_definition_set';
  END IF;
  UPDATE public.memberships SET custom_field_revision=expected_revision+1 WHERE organization_id=org AND user_id=target;
  INSERT INTO public.user_field_value_versions(organization_id,subject_user_id,revision,previous_revision,request_id,custom_field_count,time_zone,
    username,display_name,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,expected_revision,requested_id,requested_count,requested_zone,person.username,person.display_name,
      actor,editor.username,editor.display_name FROM public.users person JOIN public.users editor ON editor.id=actor WHERE person.id=target;
  RETURN QUERY SELECT expected_revision+1,false,old_count;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_create_account(target uuid,requested_id uuid,requested_fingerprint bytea,requested_username text,requested_email text,requested_name text,requested_password_hash text,
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
  -- Take the definition lock before account/profile row locks, including on exact retries.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
  actor:=public.users_require_manager();
  -- A new target is absent; an exact creation retry can compose a later field-capture command.
  -- Lock an existing scoped target with the actor/manager before the organization in both paths.
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,manager_value])
    OR (id=target AND EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target))
    ORDER BY id FOR UPDATE;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_assert_custom_field_uniqueness(target_organization uuid,target_user uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
  IF EXISTS (
    -- Normalize each bounded incoming item once before joining historical definitions and values.
    WITH incoming AS MATERIALIZED (
      SELECT definition.key,
        public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text
      FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
        AND value.revision=field.revision AND value.field_id=field.field_id
      WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision AND definition.validate_uniqueness
    )
    SELECT 1 FROM incoming
    JOIN public.custom_field_versions saved_definition ON saved_definition.organization_id=target_organization AND saved_definition.key=incoming.key
    JOIN public.user_version_custom_fields saved_field ON saved_field.organization_id=saved_definition.organization_id
      AND saved_field.field_id=saved_definition.field_id AND saved_field.field_revision=saved_definition.revision
    JOIN public.memberships member ON member.organization_id=saved_field.organization_id AND member.user_id=saved_field.subject_user_id
      AND member.custom_field_revision=saved_field.revision
    JOIN public.user_version_custom_field_values existing ON existing.organization_id=saved_field.organization_id AND existing.subject_user_id=saved_field.subject_user_id
      AND existing.revision=saved_field.revision AND existing.field_id=saved_field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    WHERE incoming.text IS NOT NULL AND existing.subject_user_id<>target_user
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION custom_field_guard_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE definition public.custom_field_definitions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Custom Field attachment bytes are immutable' USING ERRCODE='55000'; END IF;
  IF session_user='sampleify_app' AND current_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  -- The owner-only users command holds the shared definition advisory before account rows.
  -- A raw definition UPDATE can already hold its row while waiting on that advisory.
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id;
  IF definition.associated_with IS DISTINCT FROM 'users' THEN
    SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id FOR SHARE;
  END IF;
  IF definition.id IS NULL OR NOT definition.active OR definition.field_type<>'attachment'
    OR definition.associated_with NOT IN ('product','parameter','users') OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires a current active supported field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  IF definition.associated_with='users' THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'User attachments require their upload command' USING ERRCODE='42501'; END IF;
    IF NEW.uploaded_by IS DISTINCT FROM public.users_require_manager()
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'User attachment requires the actual tenant, editor and transaction time' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_upload_field_attachment(requested_id uuid,target_field uuid,expected_revision integer,
  requested_name text,requested_type text,requested_content bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid; prior record;
  definition public.custom_field_definitions; requested_sha256 text; requested_length integer;
BEGIN
  actor:=public.users_require_manager();
  IF requested_id IS NULL OR target_field IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 1 AND 2147483647
    OR requested_name IS NULL OR requested_type IS NULL OR requested_content IS NULL OR octet_length(requested_content)>20971520 THEN
    RAISE EXCEPTION 'Invalid user field attachment' USING ERRCODE='23514',CONSTRAINT='user_field_attachment_invalid_input';
  END IF;
  -- Master uploads acquire this same request namespace before their organization FK locks.
  PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||org::text||':'||requested_id::text,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
  actor:=public.users_require_manager();
  PERFORM 1 FROM public.users WHERE id=actor FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  requested_sha256:=encode(sha256(requested_content),'hex'); requested_length:=octet_length(requested_content);
  -- Compare the actual digest without selecting an old binary payload. Retry precedes current-field checks.
  SELECT file.field_id,file.field_revision,file.original_name,file.media_type,file.byte_length,file.sha256,file.uploaded_by,
    version.associated_with INTO prior FROM public.custom_field_attachments file JOIN public.custom_field_versions version
      ON version.organization_id=file.organization_id AND version.field_id=file.field_id AND version.revision=file.field_revision
    WHERE file.organization_id=org AND file.id=requested_id;
  IF FOUND THEN
    IF prior.associated_with<>'users' OR
      (prior.field_id,prior.field_revision,prior.original_name,prior.media_type,prior.byte_length,prior.sha256,prior.uploaded_by)
        IS DISTINCT FROM (target_field,expected_revision,requested_name,requested_type,requested_length,requested_sha256,actor) THEN
      RAISE EXCEPTION 'Upload request already used with different details' USING ERRCODE='23514',CONSTRAINT='user_field_attachment_request_reused';
    END IF;
    RETURN true;
  END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=org AND id=target_field;
  actor:=public.users_require_manager();
  IF definition.id IS NULL OR NOT definition.active OR definition.associated_with<>'users' OR definition.field_type<>'attachment' THEN
    RAISE EXCEPTION 'User attachment field was not found' USING ERRCODE='P0002',CONSTRAINT='user_field_attachment_field_missing';
  END IF;
  IF definition.revision<>expected_revision THEN
    RAISE EXCEPTION 'Custom Field changed; reload before uploading' USING ERRCODE='23514',CONSTRAINT='user_field_attachment_stale';
  END IF;
  INSERT INTO public.custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,requested_id,target_field,expected_revision,requested_name,requested_type,requested_content,requested_length,requested_sha256,actor);
  RETURN false;
END $$;
