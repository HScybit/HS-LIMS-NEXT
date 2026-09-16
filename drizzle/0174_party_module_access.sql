-- Q17: Customer/Vendor authoring requires configured module access.
-- Existing settings receive no inferred assignments or historical versions.
CREATE TABLE organization_module_access_versions (
  organization_id uuid NOT NULL, revision integer NOT NULL,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT module_access_version_pk PRIMARY KEY(organization_id,revision),
  CONSTRAINT module_access_settings_fk FOREIGN KEY(organization_id) REFERENCES organization_laboratory_settings(organization_id),
  CONSTRAINT module_access_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT module_access_revision CHECK(revision>0)
);
CREATE TABLE organization_module_access_modules (
  organization_id uuid NOT NULL, revision integer NOT NULL, module_key text NOT NULL, enabled boolean NOT NULL,
  role_count integer NOT NULL, user_count integer NOT NULL,
  CONSTRAINT module_access_module_pk PRIMARY KEY(organization_id,revision,module_key),
  CONSTRAINT module_access_module_version_fk FOREIGN KEY(organization_id,revision) REFERENCES organization_module_access_versions(organization_id,revision),
  CONSTRAINT module_access_module_fields CHECK(module_key IN ('customer','vendor') AND role_count BETWEEN 0 AND 500 AND user_count BETWEEN 0 AND 500)
);
CREATE TABLE organization_module_access_roles (
  organization_id uuid NOT NULL, revision integer NOT NULL, module_key text NOT NULL,
  role_id uuid NOT NULL, position integer NOT NULL, role_name text NOT NULL, role_active boolean NOT NULL,
  CONSTRAINT module_access_role_pk PRIMARY KEY(organization_id,revision,module_key,role_id),
  CONSTRAINT module_access_role_position UNIQUE(organization_id,revision,module_key,position),
  CONSTRAINT module_access_role_module_fk FOREIGN KEY(organization_id,revision,module_key) REFERENCES organization_module_access_modules(organization_id,revision,module_key),
  CONSTRAINT module_access_role_reference_fk FOREIGN KEY(organization_id,role_id) REFERENCES roles(organization_id,id),
  CONSTRAINT module_access_role_fields CHECK(position BETWEEN 0 AND 499)
);
CREATE TABLE organization_module_access_users (
  organization_id uuid NOT NULL, revision integer NOT NULL, module_key text NOT NULL,
  user_id uuid NOT NULL, position integer NOT NULL, user_name text NOT NULL, user_username text NOT NULL, user_active boolean NOT NULL,
  CONSTRAINT module_access_user_pk PRIMARY KEY(organization_id,revision,module_key,user_id),
  CONSTRAINT module_access_user_position UNIQUE(organization_id,revision,module_key,position),
  CONSTRAINT module_access_user_module_fk FOREIGN KEY(organization_id,revision,module_key) REFERENCES organization_module_access_modules(organization_id,revision,module_key),
  CONSTRAINT module_access_user_reference_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT module_access_user_fields CHECK(position BETWEEN 0 AND 499)
);
--> statement-breakpoint
CREATE FUNCTION organization_module_scope() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT session.organization_id FROM public.sessions session
  JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
  JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
  JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
  JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
  WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid
    AND session.user_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND session.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
$$;
CREATE FUNCTION organization_has_module_access(requested_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_module_access_modules module
    WHERE module.organization_id=public.organization_module_scope() AND module.module_key=requested_module AND module.enabled
      AND module.revision=(SELECT max(version.revision) FROM public.organization_module_access_versions version
        JOIN public.organization_laboratory_settings settings ON settings.organization_id=version.organization_id AND settings.revision>=version.revision
        WHERE version.organization_id=module.organization_id)
      AND (
        EXISTS (SELECT 1 FROM public.organization_module_access_users selection
          WHERE selection.organization_id=module.organization_id AND selection.revision=module.revision
            AND selection.module_key=module.module_key AND selection.user_id=nullif(current_setting('app.user_id',true),'')::uuid)
        OR EXISTS (SELECT 1 FROM public.organization_module_access_roles selection
          JOIN public.user_profiles profile ON profile.organization_id=selection.organization_id AND profile.default_role_id=selection.role_id
          JOIN public.membership_roles assignment ON assignment.organization_id=profile.organization_id AND assignment.user_id=profile.user_id AND assignment.role_id=profile.default_role_id
          JOIN public.roles role ON role.organization_id=selection.organization_id AND role.id=selection.role_id AND role.active
          WHERE selection.organization_id=module.organization_id AND selection.revision=module.revision
            AND selection.module_key=module.module_key AND profile.user_id=nullif(current_setting('app.user_id',true),'')::uuid)
      )
  )
$$;
CREATE FUNCTION organization_require_module_access(requested_module text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'Configured module access required' USING ERRCODE='42501',CONSTRAINT='organization_module_access_required';
  END IF;
  PERFORM 1 FROM public.users WHERE id=actor FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR SHARE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  IF org IS NULL OR public.organization_module_scope() IS DISTINCT FROM org OR NOT public.organization_has_module_access(requested_module) THEN
    RAISE EXCEPTION 'Configured module access required' USING ERRCODE='42501',CONSTRAINT='organization_module_access_required';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
CREATE FUNCTION organization_guard_module_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Module access history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER module_access_versions_immutable BEFORE UPDATE OR DELETE ON organization_module_access_versions
  FOR EACH ROW EXECUTE FUNCTION organization_guard_module_history();
CREATE TRIGGER module_access_modules_immutable BEFORE UPDATE OR DELETE ON organization_module_access_modules
  FOR EACH ROW EXECUTE FUNCTION organization_guard_module_history();
CREATE TRIGGER module_access_roles_immutable BEFORE UPDATE OR DELETE ON organization_module_access_roles
  FOR EACH ROW EXECUTE FUNCTION organization_guard_module_history();
CREATE TRIGGER module_access_users_immutable BEFORE UPDATE OR DELETE ON organization_module_access_users
  FOR EACH ROW EXECUTE FUNCTION organization_guard_module_history();
CREATE FUNCTION organization_check_module_access_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF (SELECT count(*) FROM public.organization_module_access_modules
      WHERE organization_id=NEW.organization_id AND revision=NEW.revision)<>2 THEN
    RAISE EXCEPTION 'Both module settings are required' USING ERRCODE='23514',CONSTRAINT='module_access_complete';
  END IF;
  IF EXISTS (
    WITH facts AS (
      SELECT module_key,'role'::text AS kind,role_count AS expected,NULL::integer AS position
        FROM public.organization_module_access_modules WHERE organization_id=NEW.organization_id AND revision=NEW.revision
      UNION ALL SELECT module_key,'user',user_count,NULL FROM public.organization_module_access_modules
        WHERE organization_id=NEW.organization_id AND revision=NEW.revision
      UNION ALL SELECT module_key,'role',NULL,position FROM public.organization_module_access_roles
        WHERE organization_id=NEW.organization_id AND revision=NEW.revision
      UNION ALL SELECT module_key,'user',NULL,position FROM public.organization_module_access_users
        WHERE organization_id=NEW.organization_id AND revision=NEW.revision
    ) SELECT 1 FROM facts GROUP BY module_key,kind
      HAVING max(expected) IS DISTINCT FROM count(position)
        OR (count(position)>0 AND (min(position)<>0 OR max(position)<>count(position)-1))
  ) THEN RAISE EXCEPTION 'Module assignments require complete ordered sets' USING ERRCODE='23514',CONSTRAINT='module_access_complete'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER module_access_complete AFTER INSERT ON organization_module_access_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION organization_check_module_access_complete();
--> statement-breakpoint
CREATE FUNCTION organization_save_module_access(p_revision integer,p_modules text[],p_enabled boolean[],
  p_role_modules text[],p_role_ids uuid[],p_user_modules text[],p_user_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.organization_lock_settings_writer(); org uuid:=public.organization_module_scope();
  head public.organization_laboratory_settings;
BEGIN
  SELECT * INTO head FROM public.organization_laboratory_settings WHERE organization_id=org FOR UPDATE;
  IF head.organization_id IS NULL OR head.revision IS DISTINCT FROM p_revision
    OR head.updated_by IS DISTINCT FROM actor OR head.updated_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'Module access requires this transaction''s settings save' USING ERRCODE='23514',CONSTRAINT='module_access_current_settings';
  END IF;
  IF p_modules IS DISTINCT FROM ARRAY['customer','vendor']::text[]
    OR cardinality(p_enabled) IS DISTINCT FROM 2 OR array_ndims(p_enabled) IS DISTINCT FROM 1 OR array_position(p_enabled,NULL) IS NOT NULL
    OR cardinality(p_role_ids) IS NULL OR cardinality(p_role_ids)>1000 OR cardinality(p_role_modules) IS DISTINCT FROM cardinality(p_role_ids)
    OR cardinality(p_user_ids) IS NULL OR cardinality(p_user_ids)>1000 OR cardinality(p_user_modules) IS DISTINCT FROM cardinality(p_user_ids)
    OR (cardinality(p_role_ids)>0 AND (array_ndims(p_role_ids)<>1 OR array_ndims(p_role_modules)<>1))
    OR (cardinality(p_user_ids)>0 AND (array_ndims(p_user_ids)<>1 OR array_ndims(p_user_modules)<>1))
    OR EXISTS (SELECT 1 FROM unnest(p_role_modules,p_role_ids) entry(module_key,id) WHERE module_key IS NULL OR module_key NOT IN ('customer','vendor') OR id IS NULL)
    OR EXISTS (SELECT 1 FROM unnest(p_user_modules,p_user_ids) entry(module_key,id) WHERE module_key IS NULL OR module_key NOT IN ('customer','vendor') OR id IS NULL) THEN
    RAISE EXCEPTION 'Module access arrays must be aligned and bounded' USING ERRCODE='23514',CONSTRAINT='module_access_input';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_role_ids) selection(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.roles role WHERE role.organization_id=org AND role.id=selection.id))
    OR EXISTS (SELECT 1 FROM unnest(p_user_ids) selection(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.memberships membership WHERE membership.organization_id=org AND membership.user_id=selection.id)) THEN
    RAISE EXCEPTION 'Module assignments require same-organization references' USING ERRCODE='23514',CONSTRAINT='module_access_reference';
  END IF;
  INSERT INTO public.organization_module_access_versions(organization_id,revision,saved_by) VALUES(org,p_revision,actor);
  INSERT INTO public.organization_module_access_modules(organization_id,revision,module_key,enabled,role_count,user_count)
    SELECT org,p_revision,module.key,module.enabled,
      (SELECT count(*) FROM unnest(p_role_modules) selection(key) WHERE selection.key=module.key),
      (SELECT count(*) FROM unnest(p_user_modules) selection(key) WHERE selection.key=module.key)
    FROM unnest(p_modules,p_enabled) module(key,enabled);
  INSERT INTO public.organization_module_access_roles(organization_id,revision,module_key,role_id,position,role_name,role_active)
    SELECT org,p_revision,selection.module_key,selection.id,
      row_number() OVER (PARTITION BY selection.module_key ORDER BY selection.ordinality)-1,role.name,role.active
    FROM unnest(p_role_modules,p_role_ids) WITH ORDINALITY selection(module_key,id,ordinality)
    JOIN public.roles role ON role.organization_id=org AND role.id=selection.id;
  -- Membership FKs preserve the selected identities. Nonlocking label reads avoid
  -- reversing the user-profile writer's user-before-organization lock order.
  INSERT INTO public.organization_module_access_users(organization_id,revision,module_key,user_id,position,user_name,user_username,user_active)
    SELECT org,p_revision,selection.module_key,selection.id,
      row_number() OVER (PARTITION BY selection.module_key ORDER BY selection.ordinality)-1,
      coalesce(nullif(person.display_name,''),nullif(person.email,''),person.id::text),person.username,person.active AND membership.active
    FROM unnest(p_user_modules,p_user_ids) WITH ORDINALITY selection(module_key,id,ordinality)
    JOIN public.memberships membership ON membership.organization_id=org AND membership.user_id=selection.id
    JOIN public.users person ON person.id=membership.user_id;
END $$;
--> statement-breakpoint
ALTER TABLE organization_module_access_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_module_access_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_module_access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_module_access_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_access_versions_read ON organization_module_access_versions FOR SELECT TO sampleify_app
  USING(organization_id=organization_module_scope() AND (app_has_permission('settings.read') OR app_has_permission('settings.manage')));
CREATE POLICY module_access_modules_read ON organization_module_access_modules FOR SELECT TO sampleify_app
  USING(organization_id=organization_module_scope() AND (app_has_permission('settings.read') OR app_has_permission('settings.manage')));
CREATE POLICY module_access_roles_read ON organization_module_access_roles FOR SELECT TO sampleify_app
  USING(organization_id=organization_module_scope() AND (app_has_permission('settings.read') OR app_has_permission('settings.manage')));
CREATE POLICY module_access_users_read ON organization_module_access_users FOR SELECT TO sampleify_app
  USING(organization_id=organization_module_scope() AND (app_has_permission('settings.read') OR app_has_permission('settings.manage')));
CREATE VIEW organization_module_role_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT role.organization_id,role.id,role.name AS label,role.active FROM public.roles role
  WHERE role.organization_id=public.organization_module_scope() AND (public.app_has_permission('settings.read') OR public.app_has_permission('settings.manage'));
CREATE VIEW organization_module_user_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT membership.organization_id,person.id,coalesce(nullif(person.display_name,''),nullif(person.email,''),person.id::text) AS label,
    person.username,person.active AND membership.active AS active
  FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
  WHERE membership.organization_id=public.organization_module_scope() AND (public.app_has_permission('settings.read') OR public.app_has_permission('settings.manage'));
REVOKE ALL ON organization_module_access_versions,organization_module_access_modules,organization_module_access_roles,organization_module_access_users,
  organization_module_role_catalog,organization_module_user_catalog FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON organization_module_access_versions,organization_module_access_modules,organization_module_access_roles,organization_module_access_users,
  organization_module_role_catalog,organization_module_user_catalog TO sampleify_app;
REVOKE ALL ON FUNCTION organization_module_scope(),organization_has_module_access(text),organization_require_module_access(text),
  organization_guard_module_history(),organization_check_module_access_complete(),organization_save_module_access(integer,text[],boolean[],text[],uuid[],text[],uuid[])
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION organization_module_scope(),organization_has_module_access(text),organization_require_module_access(text),
  organization_save_module_access(integer,text[],boolean[],text[],uuid[],text[],uuid[]) TO sampleify_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_quick_customer(display_name text, legal_name text, contact_name text, contact_email text,
  contact_phone text, billing_address text, shipping_address text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  customer_id uuid := gen_random_uuid(); customer_code text;
BEGIN
  PERFORM public.organization_require_module_access('customer');
  IF org IS NULL OR NOT public.app_has_permission('samples.create') THEN
    RAISE EXCEPTION 'Sample registration permission required' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(length(trim(display_name)) BETWEEN 1 AND 250 AND length(trim(legal_name)) BETWEEN 1 AND 250
    AND length(trim(contact_name)) BETWEEN 1 AND 200 AND length(trim(contact_email)) BETWEEN 3 AND 320
    AND trim(contact_email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    AND length(trim(contact_phone)) BETWEEN 1 AND 50 AND length(trim(billing_address)) BETWEEN 1 AND 4000
    AND length(trim(shipping_address)) BETWEEN 1 AND 4000, false) THEN
    RAISE EXCEPTION 'Complete the customer contact and address fields' USING ERRCODE = '23514';
  END IF;
  customer_code := left(trim(both '-' from regexp_replace(upper(trim(display_name)), '[^A-Z0-9._/-]+', '-', 'g')), 64);
  IF customer_code = '' THEN customer_code := 'CUSTOMER'; END IF;
  INSERT INTO public.customers(organization_id, id, code, name, legal_name, credit_days)
    VALUES (org, customer_id, customer_code, trim(display_name), trim(legal_name), 30);
  INSERT INTO public.customer_contacts(organization_id, customer_id, name, email, phone, is_primary)
    VALUES (org, customer_id, trim(contact_name), trim(contact_email), trim(contact_phone), true);
  INSERT INTO public.customer_addresses(organization_id, customer_id, address_type, freeform_address, is_default)
    VALUES (org, customer_id, 'billing', trim(billing_address), true), (org, customer_id, 'shipping', trim(shipping_address), true);
  RETURN customer_id;
END $$;
