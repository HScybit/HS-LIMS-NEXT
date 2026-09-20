-- Organization creation/listing for platform administrators. The platform_administrators
-- table and auth_is_platform_administrator() already exist (0133_user_account_administration.sql,
-- built to protect shared/cross-organization user identities) — this reuses both rather than
-- introducing a second, parallel "platform admin" concept under a different name.
DROP POLICY organization_scope ON organizations;
CREATE POLICY organization_scope ON organizations TO sampleify_app USING (
  id=nullif(current_setting('app.organization_id',true),'')::uuid OR public.auth_is_platform_administrator());
--> statement-breakpoint
CREATE FUNCTION platform_create_organization(p_code text, p_name text, p_admin_username text, p_admin_email text,
  p_admin_display_name text, p_admin_password_hash text, p_permission_codes text[], p_permission_descriptions text[],
  p_capability_keys text[]) RETURNS TABLE(organization_id uuid, admin_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org_id uuid; admin_id uuid; role_id uuid; permission_count integer:=cardinality(p_permission_codes);
BEGIN
  IF NOT public.auth_is_platform_administrator() THEN
    RAISE EXCEPTION 'Platform administrator access is required' USING ERRCODE='42501',CONSTRAINT='platform_administrator_required';
  END IF;
  IF length(trim(p_code)) NOT BETWEEN 1 AND 64 OR p_code!~'^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    OR length(trim(p_name)) NOT BETWEEN 1 AND 200
    OR length(trim(p_admin_username)) NOT BETWEEN 1 AND 100 OR length(trim(p_admin_email)) NOT BETWEEN 1 AND 320
    OR length(trim(p_admin_display_name)) NOT BETWEEN 1 AND 200 OR length(p_admin_password_hash)=0
    OR cardinality(p_permission_descriptions) IS DISTINCT FROM permission_count OR cardinality(p_capability_keys) IS NULL THEN
    RAISE EXCEPTION 'Organization and administrator fields are invalid' USING ERRCODE='23514',CONSTRAINT='platform_organization_values';
  END IF;
  INSERT INTO public.organizations(code,name) VALUES(p_code,p_name) RETURNING id INTO org_id;
  INSERT INTO public.users(username,email,display_name,must_change_password) VALUES(p_admin_username,p_admin_email,p_admin_display_name,true) RETURNING id INTO admin_id;
  INSERT INTO public.credentials(user_id,password_hash) VALUES(admin_id,p_admin_password_hash);
  INSERT INTO public.memberships(organization_id,user_id,is_default) VALUES(org_id,admin_id,true);
  INSERT INTO public.roles(organization_id,name,description,protected) VALUES(org_id,'System Administrator','Full organization administration.',true) RETURNING id INTO role_id;
  INSERT INTO public.membership_roles(organization_id,user_id,role_id) VALUES(org_id,admin_id,role_id);
  INSERT INTO public.role_capabilities(organization_id,role_id,capability_key)
    SELECT org_id,role_id,item.key FROM unnest(p_capability_keys) item(key);
  INSERT INTO public.permissions(code,description)
    SELECT perm.code,perm.description FROM unnest(p_permission_codes,p_permission_descriptions) AS perm(code,description)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.role_permissions(organization_id,role_id,permission_code)
    SELECT org_id,role_id,item.code FROM unnest(p_permission_codes) item(code);
  RETURN QUERY SELECT org_id,admin_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION platform_update_organization(target_id uuid, p_code text, p_name text, p_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.auth_is_platform_administrator() THEN
    RAISE EXCEPTION 'Platform administrator access is required' USING ERRCODE='42501',CONSTRAINT='platform_administrator_required';
  END IF;
  IF length(trim(p_code)) NOT BETWEEN 1 AND 64 OR p_code!~'^[A-Za-z0-9][A-Za-z0-9._/-]*$' OR length(trim(p_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Organization fields are invalid' USING ERRCODE='23514',CONSTRAINT='platform_organization_values';
  END IF;
  UPDATE public.organizations SET code=p_code,name=p_name,active=p_active WHERE id=target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization was not found' USING ERRCODE='P0002',CONSTRAINT='platform_organization_not_found';
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_create_organization(text,text,text,text,text,text,text[],text[],text[]),
  platform_update_organization(uuid,text,text,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION platform_create_organization(text,text,text,text,text,text,text[],text[],text[]),
  platform_update_organization(uuid,text,text,boolean) TO sampleify_app;
