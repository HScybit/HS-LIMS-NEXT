CREATE TABLE "role_capabilities" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"capability_key" text NOT NULL,
	CONSTRAINT "role_capability_pk" PRIMARY KEY("organization_id","role_id","capability_key"),
	CONSTRAINT "role_capability_key" CHECK ("role_capabilities"."capability_key" in ('can_admin','is_creator','can_access_all_ds','can_access_sample_listing','show_in_ds_allocation','can_self_allocate','show_sample_id_in_tr_listing','can_config_datasheets','show_pf_data','can_view_customer_details','can_create_amendment','can_create_complaint','can_print_acknowledgement','can_generate_adhoc_test_req','can_dispose_samples','can_access_instruments_all','can_access_instruments_my_lab','can_create_sample'))
);
--> statement-breakpoint
CREATE TABLE "role_version_capabilities" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"capability_key" text NOT NULL,
	CONSTRAINT "role_version_capability_pk" PRIMARY KEY("organization_id","role_id","revision","capability_key"),
	CONSTRAINT "role_version_capability_key" CHECK ("role_version_capabilities"."capability_key" in ('can_admin','is_creator','can_access_all_ds','can_access_sample_listing','show_in_ds_allocation','can_self_allocate','show_sample_id_in_tr_listing','can_config_datasheets','show_pf_data','can_view_customer_details','can_create_amendment','can_create_complaint','can_print_acknowledgement','can_generate_adhoc_test_req','can_dispose_samples','can_access_instruments_all','can_access_instruments_my_lab','can_create_sample'))
);
--> statement-breakpoint
CREATE TABLE "role_version_permissions" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"permission_code" text NOT NULL,
	CONSTRAINT "role_version_permission_pk" PRIMARY KEY("organization_id","role_id","revision","permission_code")
);
--> statement-breakpoint
CREATE TABLE "role_versions" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"default_path" text,
	"active" boolean NOT NULL,
	"protected" boolean NOT NULL,
	"permission_count" integer NOT NULL,
	"capability_count" integer NOT NULL,
	"description_provided" boolean NOT NULL,
	"default_path_provided" boolean NOT NULL,
	"permissions_provided" boolean NOT NULL,
	"capabilities_provided" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "role_version_pk" PRIMARY KEY("organization_id","role_id","revision"),
	CONSTRAINT "role_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "role_version_revision" CHECK (("role_versions"."operation"='create' and "role_versions"."previous_revision" is null and "role_versions"."revision"=1)
    or ("role_versions"."operation" in ('update','retire') and "role_versions"."previous_revision" is not null and "role_versions"."previous_revision">=0 and "role_versions"."revision"="role_versions"."previous_revision"+1)),
	CONSTRAINT "role_version_fields" CHECK (length(trim("role_versions"."name")) between 1 and 150 and length("role_versions"."description")<=2000
    and ("role_versions"."default_path" is null or length("role_versions"."default_path")<=300) and ("role_versions"."active"=("role_versions"."operation"<>'retire'))
    and (not "role_versions"."protected" or "role_versions"."active") and "role_versions"."permission_count" between 0 and 500 and "role_versions"."capability_count" between 0 and 18
    and ("role_versions"."operation"<>'retire' or not ("role_versions"."description_provided" or "role_versions"."default_path_provided" or "role_versions"."permissions_provided" or "role_versions"."capabilities_provided")))
);
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "default_path" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "self_allocation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capability_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_version_capabilities" ADD CONSTRAINT "role_version_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_version_capabilities" ADD CONSTRAINT "role_version_capability_parent_fk" FOREIGN KEY ("organization_id","role_id","revision") REFERENCES "public"."role_versions"("organization_id","role_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_version_permissions" ADD CONSTRAINT "role_version_permissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_version_permissions" ADD CONSTRAINT "role_version_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_version_permissions" ADD CONSTRAINT "role_version_permission_parent_fk" FOREIGN KEY ("organization_id","role_id","revision") REFERENCES "public"."role_versions"("organization_id","role_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_versions" ADD CONSTRAINT "role_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_versions" ADD CONSTRAINT "role_version_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_versions" ADD CONSTRAINT "role_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_version_time" ON "role_versions" USING btree ("organization_id","saved_at");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "role_fields" CHECK (length(trim("roles"."name")) between 1 and 150 and length("roles"."description")<=2000
    and ("roles"."default_path" is null or length("roles"."default_path")<=300) and "roles"."revision">=0
    and (not "roles"."protected" or "roles"."active"));--> statement-breakpoint
CREATE VIEW "public"."role_management_settings" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT organization.id AS organization_id,coalesce(settings.self_allocation_enabled,false) AS self_allocation_enabled
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('roles.read') OR public.app_has_permission('roles.manage'))
);
--> statement-breakpoint
-- Retired roles cannot grant authority or appear in an authenticated role list.
CREATE OR REPLACE FUNCTION app_has_permission(permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.membership_roles mr
    JOIN public.role_permissions rp USING (organization_id, role_id)
    JOIN public.roles role ON role.organization_id=mr.organization_id AND role.id=mr.role_id AND role.active
    WHERE mr.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
      AND mr.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND rp.permission_code = permission
  )
$$;
CREATE OR REPLACE FUNCTION auth_session_context(requested_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, organization_id uuid, csrf_hash text,
  username text, email text, display_name text, organization_name text, must_change_password boolean,
  revision integer, mfa_enabled boolean, role_names text[], permission_codes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE found_user uuid; found_organization uuid;
BEGIN
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.organization_id', '', true);
  PERFORM set_config('app.session_id', '', true);
  SELECT s.user_id, s.organization_id INTO found_user, found_organization
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id AND u.active
  JOIN public.credentials c ON c.user_id = u.id AND c.revision = s.credential_revision
  JOIN public.memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id AND m.active
  JOIN public.organizations o ON o.id = s.organization_id AND o.active
  WHERE s.token_hash = requested_hash AND s.revoked_at IS NULL AND s.expires_at > now();
  IF found_user IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.user_id', found_user::text, true);
  PERFORM set_config('app.organization_id', found_organization::text, true);
  PERFORM set_config('app.session_id', (SELECT s.id::text FROM public.sessions s WHERE s.token_hash = requested_hash), true);
  RETURN QUERY SELECT s.id, u.id, o.id, s.csrf_hash, u.username, u.email, u.display_name, o.name,
    u.must_change_password, u.revision, coalesce(mfa.enabled, false),
    ARRAY(SELECT r.name FROM public.membership_roles mr JOIN public.roles r
      ON r.organization_id = mr.organization_id AND r.id = mr.role_id AND r.active
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY r.name),
    ARRAY(SELECT DISTINCT rp.permission_code FROM public.membership_roles mr JOIN public.role_permissions rp
      ON rp.organization_id = mr.organization_id AND rp.role_id = mr.role_id
      JOIN public.roles role ON role.organization_id=mr.organization_id AND role.id=mr.role_id AND role.active
      WHERE mr.organization_id = o.id AND mr.user_id = u.id ORDER BY rp.permission_code)
  FROM public.sessions s JOIN public.users u ON u.id = s.user_id
  JOIN public.organizations o ON o.id = s.organization_id
  LEFT JOIN public.user_mfa mfa ON mfa.user_id = u.id
  WHERE s.token_hash = requested_hash;
END $$;
--> statement-breakpoint
-- Roles are authorization roots. Runtime writes remain unavailable on their tables.
INSERT INTO permissions(code,description) VALUES ('roles.read','View roles'),('roles.manage','Manage roles') ON CONFLICT DO NOTHING;
REVOKE ALL ON role_capabilities,role_versions,role_version_permissions,role_version_capabilities,role_management_settings FROM PUBLIC;
GRANT SELECT ON role_capabilities,role_versions,role_version_permissions,role_version_capabilities,role_management_settings TO sampleify_app;

CREATE FUNCTION roles_require_actor() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions session
    JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
    JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
    JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
    JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
    WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid AND session.user_id=actor AND session.organization_id=org
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  ) OR NOT public.app_has_permission('roles.manage') THEN
    RAISE EXCEPTION 'Active role management session required' USING ERRCODE='42501',CONSTRAINT='role_session_required';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION roles_guard_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.role_versions; stored_role public.roles;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Role history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='role_versions' THEN
    SELECT * INTO stored_role FROM public.roles WHERE organization_id=NEW.organization_id AND id=NEW.role_id;
    IF NEW.saved_by IS DISTINCT FROM public.roles_require_actor()
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (NEW.revision,NEW.name,NEW.description,NEW.default_path,NEW.active,NEW.protected)
        IS DISTINCT FROM (stored_role.revision,stored_role.name,stored_role.description,stored_role.default_path,stored_role.active,stored_role.protected) THEN
      RAISE EXCEPTION 'Role history requires the current head, actual editor and transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.role_versions WHERE organization_id=NEW.organization_id AND role_id=NEW.role_id AND revision=NEW.revision;
    IF version.role_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR version.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
      RAISE EXCEPTION 'Role links require their actual version transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION roles_assert_version(org uuid,target uuid,target_revision integer,check_head boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.role_versions; head public.roles; stored_permissions text[]; stored_capabilities text[];
BEGIN
  SELECT * INTO version FROM public.role_versions WHERE organization_id=org AND role_id=target AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role version is missing' USING ERRCODE='23514'; END IF;
  SELECT ARRAY(SELECT permission_code FROM public.role_version_permissions WHERE organization_id=org AND role_id=target AND revision=target_revision ORDER BY permission_code),
    ARRAY(SELECT capability_key FROM public.role_version_capabilities WHERE organization_id=org AND role_id=target AND revision=target_revision ORDER BY capability_key)
    INTO stored_permissions,stored_capabilities;
  IF cardinality(stored_permissions)<>version.permission_count OR cardinality(stored_capabilities)<>version.capability_count THEN
    RAISE EXCEPTION 'Role history requires complete permission and capability sets' USING ERRCODE='23514';
  END IF;
  IF check_head THEN
    SELECT * INTO head FROM public.roles WHERE organization_id=org AND id=target;
    IF (head.revision,head.name,head.description,head.default_path,head.active,head.protected)
      IS DISTINCT FROM (version.revision,version.name,version.description,version.default_path,version.active,version.protected)
      OR stored_permissions IS DISTINCT FROM ARRAY(SELECT permission_code FROM public.role_permissions WHERE organization_id=org AND role_id=target ORDER BY permission_code)
      OR stored_capabilities IS DISTINCT FROM ARRAY(SELECT capability_key FROM public.role_capabilities WHERE organization_id=org AND role_id=target ORDER BY capability_key) THEN
      RAISE EXCEPTION 'Current role must match its saved version' USING ERRCODE='23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION roles_check_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.roles; org uuid; target uuid;
BEGIN
  org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF TG_TABLE_NAME='roles' THEN target:=NEW.id;
  ELSE target:=CASE WHEN TG_OP='DELETE' THEN OLD.role_id ELSE NEW.role_id END; END IF;
  SELECT * INTO head FROM public.roles WHERE organization_id=org AND id=target;
  IF TG_TABLE_NAME='role_versions' THEN
    PERFORM public.roles_assert_version(org,target,NEW.revision,head.revision=NEW.revision);
  ELSIF head.revision>0 THEN
    PERFORM public.roles_assert_version(org,target,head.revision,true);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION roles_guard_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.revision>0 THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Saved roles cannot be deleted' USING ERRCODE='55000'; END IF;
    IF (NEW.organization_id,NEW.id,NEW.protected) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.protected)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Role identity and active revision are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION roles_guard_current_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.roles; version public.role_versions; org uuid; target uuid;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace role links through a saved revision' USING ERRCODE='23514'; END IF;
  org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  SELECT * INTO head FROM public.roles WHERE organization_id=org AND id=target;
  IF head.revision>0 THEN
    SELECT * INTO version FROM public.role_versions WHERE organization_id=org AND role_id=target AND revision=head.revision;
    IF version.role_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR org IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
      RAISE EXCEPTION 'Role links require their current saved revision transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION roles_guard_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- The role command holds FOR UPDATE on this same row. Recheck active after waiting.
  PERFORM 1 FROM public.roles WHERE organization_id=NEW.organization_id AND id=NEW.role_id AND active FOR KEY SHARE;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM public.roles WHERE organization_id=NEW.organization_id AND id=NEW.role_id) THEN
    RAISE EXCEPTION 'Select an active role in this organization' USING ERRCODE='23514',CONSTRAINT='role_inactive_assignment';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['role_capabilities','role_versions','role_version_permissions','role_version_capabilities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY role_history_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''roles.read'') OR app_has_permission(''roles.manage'')))',relation);
    IF relation<>'role_capabilities' THEN
      EXECUTE format('CREATE TRIGGER role_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION roles_guard_history()',relation);
    END IF;
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['roles','role_versions'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER role_complete AFTER INSERT OR UPDATE OR DELETE ON %I
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION roles_check_complete()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['role_permissions','role_capabilities'] LOOP
    EXECUTE format('CREATE TRIGGER role_current_links_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION roles_guard_current_links()',relation);
  END LOOP;
END $$;
CREATE TRIGGER role_head_guard BEFORE UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION roles_guard_head();
CREATE TRIGGER role_assignment_guard BEFORE INSERT OR UPDATE ON membership_roles FOR EACH ROW EXECUTE FUNCTION roles_guard_assignment();

CREATE FUNCTION roles_write(operation text,target uuid,expected_revision integer,requested_id uuid,requested_name text,
  requested_description text,description_provided boolean,requested_path text,path_provided boolean,requested_permissions text[],requested_capabilities text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  stored_role public.roles; prior public.role_versions; next_revision integer;
  next_name text; next_description text; next_path text; next_permissions text[]; next_capabilities text[];
BEGIN
  actor:=public.roles_require_actor();
  -- Serializes all role changes in an organization, including two administrators removing each other's grants.
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  actor:=public.roles_require_actor();
  IF operation IS NULL OR operation NOT IN ('create','update','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646
    OR (operation='create' AND expected_revision<>0) OR description_provided IS NULL OR path_provided IS NULL
    OR (NOT description_provided AND requested_description IS NOT NULL) OR (description_provided AND requested_description IS NULL)
    OR (NOT path_provided AND requested_path IS NOT NULL)
    OR (operation='retire' AND (num_nonnulls(requested_name,requested_description,requested_path,requested_permissions,requested_capabilities)<>0 OR description_provided OR path_provided))
    OR (operation<>'retire' AND (requested_name IS NULL OR length(trim(requested_name)) NOT BETWEEN 1 AND 150 OR requested_name<>trim(requested_name)))
    OR length(requested_description)>2000 OR length(requested_path)>300
    OR (requested_permissions IS NOT NULL AND (coalesce(array_ndims(requested_permissions),1)<>1 OR cardinality(requested_permissions)>500
      OR cardinality(requested_permissions)<>(SELECT count(DISTINCT item) FROM unnest(requested_permissions) item)
      OR EXISTS (SELECT 1 FROM unnest(requested_permissions) item WHERE item IS NULL OR length(trim(item)) NOT BETWEEN 1 AND 150)))
    OR (requested_capabilities IS NOT NULL AND (coalesce(array_ndims(requested_capabilities),1)<>1 OR cardinality(requested_capabilities)>18
      OR cardinality(requested_capabilities)<>(SELECT count(DISTINCT item) FROM unnest(requested_capabilities) item))) THEN
    RAISE EXCEPTION 'Invalid role command' USING ERRCODE='23514',CONSTRAINT='role_invalid_input';
  END IF;
  SELECT * INTO prior FROM public.role_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF prior.role_id<>target OR prior.operation<>operation OR coalesce(prior.previous_revision,0)<>expected_revision OR prior.saved_by<>actor
      OR prior.description_provided<>description_provided OR prior.default_path_provided<>path_provided
      OR prior.permissions_provided<>(requested_permissions IS NOT NULL) OR prior.capabilities_provided<>(requested_capabilities IS NOT NULL)
      OR (operation<>'retire' AND prior.name IS DISTINCT FROM requested_name)
      OR (description_provided AND prior.description IS DISTINCT FROM requested_description)
      OR (path_provided AND prior.default_path IS DISTINCT FROM requested_path)
      OR (requested_permissions IS NOT NULL AND ARRAY(SELECT item FROM unnest(requested_permissions) item ORDER BY item)
        IS DISTINCT FROM ARRAY(SELECT permission_code FROM public.role_version_permissions WHERE organization_id=org AND role_id=target AND revision=prior.revision ORDER BY permission_code))
      OR (requested_capabilities IS NOT NULL AND ARRAY(SELECT item FROM unnest(requested_capabilities) item ORDER BY item)
        IS DISTINCT FROM ARRAY(SELECT capability_key FROM public.role_version_capabilities WHERE organization_id=org AND role_id=target AND revision=prior.revision ORDER BY capability_key)) THEN
      RAISE EXCEPTION 'Role request was used for a different change' USING ERRCODE='23514',CONSTRAINT='role_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO stored_role FROM public.roles WHERE organization_id=org AND id=target FOR UPDATE;
  IF operation='create' AND FOUND THEN RAISE EXCEPTION 'Role already exists' USING ERRCODE='23514',CONSTRAINT='role_identifier_exists'; END IF;
  IF operation<>'create' AND (stored_role.id IS NULL OR NOT stored_role.active) THEN
    RAISE EXCEPTION 'Role was not found' USING ERRCODE='P0002',CONSTRAINT='role_not_found';
  END IF;
  IF operation<>'create' AND stored_role.revision<>expected_revision THEN
    RAISE EXCEPTION 'Role changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='role_stale';
  END IF;
  IF operation='retire' THEN
    IF stored_role.protected THEN RAISE EXCEPTION 'Protected roles cannot be deleted' USING ERRCODE='23514',CONSTRAINT='role_protected'; END IF;
    IF EXISTS (SELECT 1 FROM public.membership_roles WHERE organization_id=org AND role_id=target) THEN
      RAISE EXCEPTION 'Assigned roles cannot be deleted' USING ERRCODE='23514',CONSTRAINT='role_assigned';
    END IF;
  END IF;
  IF stored_role.revision>0 THEN PERFORM public.roles_assert_version(org,target,stored_role.revision,true); END IF;
  next_revision:=expected_revision+1;
  next_name:=CASE WHEN operation='retire' THEN stored_role.name ELSE requested_name END;
  next_description:=CASE WHEN description_provided THEN requested_description ELSE coalesce(stored_role.description,'') END;
  next_path:=CASE WHEN path_provided THEN requested_path ELSE stored_role.default_path END;
  next_permissions:=coalesce(requested_permissions,ARRAY(SELECT permission_code FROM public.role_permissions WHERE organization_id=org AND role_id=target ORDER BY permission_code));
  next_capabilities:=coalesce(requested_capabilities,ARRAY(SELECT capability_key FROM public.role_capabilities WHERE organization_id=org AND role_id=target ORDER BY capability_key));
  IF EXISTS (SELECT 1 FROM unnest(next_permissions) candidate(code) WHERE NOT EXISTS (SELECT 1 FROM public.permissions permission WHERE permission.code=candidate.code)) THEN
    RAISE EXCEPTION 'Unknown API permission' USING ERRCODE='23514',CONSTRAINT='role_unknown_permission';
  END IF;
  -- Evaluate the proposed grants before mutating them, so the audit insert still has the actual editor's authority.
  IF NOT EXISTS (
    SELECT 1 FROM public.membership_roles assignment JOIN public.roles role ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id AND role.active
    JOIN public.memberships membership ON membership.organization_id=assignment.organization_id AND membership.user_id=assignment.user_id AND membership.active
    JOIN public.users person ON person.id=membership.user_id AND person.active
    JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code='roles.manage'
    WHERE assignment.organization_id=org AND (role.id<>target OR (operation<>'retire' AND 'roles.manage'=ANY(next_permissions)))
  ) THEN RAISE EXCEPTION 'The last active role administrator must be retained' USING ERRCODE='23514',CONSTRAINT='role_last_administrator'; END IF;
  IF operation='create' THEN
    INSERT INTO public.roles(organization_id,id,name,description,default_path,revision) VALUES(org,target,next_name,next_description,next_path,next_revision);
  ELSE
    UPDATE public.roles SET name=next_name,description=next_description,default_path=next_path,active=operation<>'retire',revision=next_revision
      WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.role_versions(organization_id,role_id,revision,request_id,previous_revision,operation,name,description,default_path,active,protected,
    permission_count,capability_count,description_provided,default_path_provided,permissions_provided,capabilities_provided,saved_by)
    VALUES(org,target,next_revision,requested_id,CASE WHEN operation='create' THEN NULL ELSE expected_revision END,operation,next_name,next_description,next_path,
      operation<>'retire',coalesce(stored_role.protected,false),cardinality(next_permissions),cardinality(next_capabilities),description_provided,path_provided,
      requested_permissions IS NOT NULL,requested_capabilities IS NOT NULL,actor);
  INSERT INTO public.role_version_permissions(organization_id,role_id,revision,permission_code) SELECT org,target,next_revision,code FROM unnest(next_permissions) code;
  INSERT INTO public.role_version_capabilities(organization_id,role_id,revision,capability_key) SELECT org,target,next_revision,key FROM unnest(next_capabilities) key;
  DELETE FROM public.role_permissions WHERE organization_id=org AND role_id=target;
  DELETE FROM public.role_capabilities WHERE organization_id=org AND role_id=target;
  INSERT INTO public.role_permissions(organization_id,role_id,permission_code) SELECT org,target,code FROM unnest(next_permissions) code;
  INSERT INTO public.role_capabilities(organization_id,role_id,capability_key) SELECT org,target,key FROM unnest(next_capabilities) key;
  RETURN next_revision;
END $$;

REVOKE ALL ON FUNCTION roles_require_actor(),roles_guard_history(),roles_assert_version(uuid,uuid,integer,boolean),roles_check_complete(),roles_guard_head(),
  roles_guard_current_links(),roles_guard_assignment(),
  roles_write(text,uuid,integer,uuid,text,text,boolean,text,boolean,text[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION roles_write(text,uuid,integer,uuid,text,text,boolean,text,boolean,text[],text[]) TO sampleify_app;

--> statement-breakpoint
CREATE INDEX "membership_roles_role" ON "membership_roles" USING btree ("organization_id","role_id","user_id");
