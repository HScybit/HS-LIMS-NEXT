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
