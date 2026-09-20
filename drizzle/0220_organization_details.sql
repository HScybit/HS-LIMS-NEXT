-- Matches PERN's organization record shape (packages/database/migrations/001_foundation.sql
-- plus its later CRM-ish additions) so the platform-administrator Organizations form/listing
-- can carry the same fields. `active` stays the functional gate every existing RLS/session
-- check already relies on; `status` is the richer, three-state field the form/listing manage,
-- kept in sync with `active` by the two platform_* write functions (status='active' <=> active).
ALTER TABLE organizations ADD COLUMN domain text;
ALTER TABLE organizations ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE organizations ADD COLUMN active_from_date date;
ALTER TABLE organizations ADD COLUMN active_till_date date;
ALTER TABLE organizations ADD COLUMN account_type text NOT NULL DEFAULT 'saas';
ALTER TABLE organizations ADD COLUMN purchase_order_number text;
ALTER TABLE organizations ADD COLUMN address text;
ALTER TABLE organizations ADD COLUMN contact_person text;
ALTER TABLE organizations ADD COLUMN contact_phone text;
ALTER TABLE organizations ADD COLUMN project_manager text;
ALTER TABLE organizations ADD COLUMN sales_person text;
ALTER TABLE organizations ADD COLUMN pricing_plan text;
ALTER TABLE organizations ADD COLUMN subscription_cost numeric;
ALTER TABLE organizations ADD COLUMN custom_development_cost numeric;
ALTER TABLE organizations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
UPDATE organizations SET status='active' WHERE active;
UPDATE organizations SET status='suspended' WHERE NOT active;
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organization_status CHECK (status IN ('active','suspended','archived'));
ALTER TABLE organizations ADD CONSTRAINT organization_account_type CHECK (account_type IN ('saas','enterprise'));
ALTER TABLE organizations ADD CONSTRAINT organization_active_matches_status CHECK (active = (status='active'));
ALTER TABLE organizations ADD CONSTRAINT organization_active_dates CHECK (active_from_date IS NULL OR active_till_date IS NULL OR active_from_date<=active_till_date);
ALTER TABLE organizations ADD CONSTRAINT organization_costs CHECK (
  (subscription_cost IS NULL OR (subscription_cost>=0 AND subscription_cost NOT IN ('NaN','Infinity','-Infinity')))
  AND (custom_development_cost IS NULL OR (custom_development_cost>=0 AND custom_development_cost NOT IN ('NaN','Infinity','-Infinity'))));
ALTER TABLE organizations ADD CONSTRAINT organization_text_fields CHECK (
  (domain IS NULL OR length(domain) BETWEEN 1 AND 200) AND (purchase_order_number IS NULL OR length(purchase_order_number)<=100)
  AND (address IS NULL OR length(address)<=4000) AND (contact_person IS NULL OR length(contact_person)<=200)
  AND (contact_phone IS NULL OR length(contact_phone)<=50) AND (project_manager IS NULL OR length(project_manager)<=200)
  AND (sales_person IS NULL OR length(sales_person)<=200) AND (pricing_plan IS NULL OR length(pricing_plan)<=200));
CREATE UNIQUE INDEX organizations_domain_key ON organizations(lower(domain)) WHERE domain IS NOT NULL;
--> statement-breakpoint
-- Both functions' argument lists are changing (new organization detail fields), so the old
-- overloads must be dropped explicitly rather than CREATE OR REPLACE, which would otherwise
-- leave the previous 9-arg/4-arg versions in place as separate overloads.
DROP FUNCTION platform_create_organization(text,text,text,text,text,text,text[],text[],text[]);
DROP FUNCTION platform_update_organization(uuid,text,text,boolean);
--> statement-breakpoint
CREATE FUNCTION platform_create_organization(p_name text, p_admin_username text, p_admin_email text,
  p_admin_display_name text, p_admin_password_hash text, p_permission_codes text[], p_permission_descriptions text[],
  p_capability_keys text[], p_domain text, p_status text, p_active_from_date date, p_active_till_date date, p_account_type text,
  p_purchase_order_number text, p_address text, p_contact_person text, p_contact_phone text, p_project_manager text,
  p_sales_person text, p_pricing_plan text, p_subscription_cost numeric, p_custom_development_cost numeric)
  RETURNS TABLE(organization_id uuid, admin_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE org_id uuid; admin_id uuid; role_id uuid; permission_count integer:=cardinality(p_permission_codes);
  code_base text; candidate_code text; suffix integer:=0;
BEGIN
  IF NOT public.auth_is_platform_administrator() THEN
    RAISE EXCEPTION 'Platform administrator access is required' USING ERRCODE='42501',CONSTRAINT='platform_administrator_required';
  END IF;
  IF length(trim(p_name)) NOT BETWEEN 1 AND 200
    OR length(trim(p_admin_username)) NOT BETWEEN 1 AND 100 OR length(trim(p_admin_email)) NOT BETWEEN 1 AND 320
    OR length(trim(p_admin_display_name)) NOT BETWEEN 1 AND 200 OR length(p_admin_password_hash)=0
    OR cardinality(p_permission_descriptions) IS DISTINCT FROM permission_count OR cardinality(p_capability_keys) IS NULL THEN
    RAISE EXCEPTION 'Organization and administrator fields are invalid' USING ERRCODE='23514',CONSTRAINT='platform_organization_values';
  END IF;
  -- The organization code is never user-facing (matches PERN) — derive it from the
  -- domain or name, resolving collisions under an advisory lock the way PERN's own
  -- resolveOrganizationCode does, just server-side instead of at the API layer.
  PERFORM pg_advisory_xact_lock(hashtext('sampleify_organization_code'));
  code_base:=upper(regexp_replace(coalesce(nullif(trim(p_domain),''),p_name,'ORGANIZATION'),'[^A-Za-z0-9]+','-','g'));
  code_base:=trim(both '-' from code_base);
  IF code_base='' THEN code_base:='ORGANIZATION'; END IF;
  code_base:=left(code_base,64);
  LOOP
    candidate_code:=CASE WHEN suffix=0 THEN code_base ELSE left(code_base,64-length('-'||suffix::text))||'-'||suffix::text END;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.organizations WHERE lower(code)=lower(candidate_code));
    suffix:=suffix+1;
    IF suffix>1000 THEN RAISE EXCEPTION 'Could not derive a unique organization code' USING ERRCODE='23514',CONSTRAINT='platform_organization_values'; END IF;
  END LOOP;
  INSERT INTO public.organizations(code,name,active,domain,status,active_from_date,active_till_date,account_type,purchase_order_number,
      address,contact_person,contact_phone,project_manager,sales_person,pricing_plan,subscription_cost,custom_development_cost)
    VALUES(candidate_code,p_name,p_status='active',p_domain,p_status,p_active_from_date,p_active_till_date,p_account_type,p_purchase_order_number,
      p_address,p_contact_person,p_contact_phone,p_project_manager,p_sales_person,p_pricing_plan,p_subscription_cost,p_custom_development_cost)
    RETURNING id INTO org_id;
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
END $function$;
--> statement-breakpoint
-- The organization code is immutable after creation (matches PERN's own edit form,
-- which never submits a code field either) — this never touches the code column.
CREATE FUNCTION platform_update_organization(target_id uuid, p_name text, p_domain text,
  p_status text, p_active_from_date date, p_active_till_date date, p_account_type text, p_purchase_order_number text, p_address text,
  p_contact_person text, p_contact_phone text, p_project_manager text, p_sales_person text, p_pricing_plan text,
  p_subscription_cost numeric, p_custom_development_cost numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF NOT public.auth_is_platform_administrator() THEN
    RAISE EXCEPTION 'Platform administrator access is required' USING ERRCODE='42501',CONSTRAINT='platform_administrator_required';
  END IF;
  IF length(trim(p_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Organization fields are invalid' USING ERRCODE='23514',CONSTRAINT='platform_organization_values';
  END IF;
  UPDATE public.organizations SET name=p_name,domain=p_domain,status=p_status,active=(p_status='active'),
    active_from_date=p_active_from_date,active_till_date=p_active_till_date,account_type=p_account_type,
    purchase_order_number=p_purchase_order_number,address=p_address,contact_person=p_contact_person,contact_phone=p_contact_phone,
    project_manager=p_project_manager,sales_person=p_sales_person,pricing_plan=p_pricing_plan,subscription_cost=p_subscription_cost,
    custom_development_cost=p_custom_development_cost,updated_at=transaction_timestamp() WHERE id=target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization was not found' USING ERRCODE='P0002',CONSTRAINT='platform_organization_not_found';
  END IF;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_create_organization(text,text,text,text,text,text[],text[],text[],text,text,date,date,text,text,text,text,text,text,text,text,numeric,numeric),
  platform_update_organization(uuid,text,text,text,date,date,text,text,text,text,text,text,text,text,numeric,numeric) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION platform_create_organization(text,text,text,text,text,text[],text[],text[],text,text,date,date,text,text,text,text,text,text,text,text,numeric,numeric),
  platform_update_organization(uuid,text,text,text,date,date,text,text,text,text,text,text,text,text,numeric,numeric) TO sampleify_app;
