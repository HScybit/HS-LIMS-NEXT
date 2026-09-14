CREATE TABLE "business_units" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_units_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "business_unit_fields" CHECK (length(trim("business_units"."code")) between 1 and 64 and length(trim("business_units"."name")) between 1 and 200
    and ("business_units"."description" is null or length("business_units"."description")<=2000) and "business_units"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "user_profile_version_roles" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"role_id" uuid NOT NULL,
	"recorded_role_revision" integer,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"active" boolean NOT NULL,
	"explicitly_selected" boolean NOT NULL,
	CONSTRAINT "user_profile_version_role_pk" PRIMARY KEY("organization_id","user_id","revision","role_id"),
	CONSTRAINT "user_profile_observed_role_revision" CHECK ("user_profile_version_roles"."recorded_role_revision" is null or "user_profile_version_roles"."recorded_role_revision">0)
);
--> statement-breakpoint
CREATE TABLE "user_profile_versions" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_code" text,
	"phone" text,
	"designation" text,
	"can_manage_people" boolean NOT NULL,
	"business_unit_id" uuid,
	"default_role_id" uuid NOT NULL,
	"laboratory_id" uuid NOT NULL,
	"reporting_manager_id" uuid,
	"revision" integer NOT NULL,
	"previous_revision" integer,
	"request_id" uuid NOT NULL,
	"employee_code_provided" boolean NOT NULL,
	"phone_provided" boolean NOT NULL,
	"designation_provided" boolean NOT NULL,
	"can_manage_people_provided" boolean NOT NULL,
	"business_unit_provided" boolean NOT NULL,
	"default_role_provided" boolean NOT NULL,
	"laboratory_provided" boolean NOT NULL,
	"reporting_manager_provided" boolean NOT NULL,
	"roles_provided" boolean NOT NULL,
	"business_unit_code" text,
	"business_unit_name" text,
	"laboratory_code" text NOT NULL,
	"laboratory_name" text NOT NULL,
	"reporting_manager_username" text,
	"reporting_manager_name" text,
	"role_count" integer NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_by_username" text NOT NULL,
	"saved_by_name" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "user_profile_version_pk" PRIMARY KEY("organization_id","user_id","revision"),
	CONSTRAINT "user_profile_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "user_profile_version_fields" CHECK (("user_profile_versions"."employee_code" is null or length("user_profile_versions"."employee_code") between 1 and 100)
  and ("user_profile_versions"."phone" is null or length("user_profile_versions"."phone") between 1 and 50) and ("user_profile_versions"."designation" is null or length("user_profile_versions"."designation") between 1 and 150)
  and "user_profile_versions"."reporting_manager_id" is distinct from "user_profile_versions"."user_id"),
	CONSTRAINT "user_profile_version_revision" CHECK (("user_profile_versions"."previous_revision" is null and "user_profile_versions"."revision"=1)
    or ("user_profile_versions"."previous_revision" is not null and "user_profile_versions"."previous_revision">0 and "user_profile_versions"."revision"="user_profile_versions"."previous_revision"+1)),
	CONSTRAINT "user_profile_version_details" CHECK ("user_profile_versions"."role_count">0
    and (("user_profile_versions"."business_unit_id" is null and num_nonnulls("user_profile_versions"."business_unit_code","user_profile_versions"."business_unit_name")=0)
      or ("user_profile_versions"."business_unit_id" is not null and num_nonnulls("user_profile_versions"."business_unit_code","user_profile_versions"."business_unit_name")=2))
    and (("user_profile_versions"."reporting_manager_id" is null and num_nonnulls("user_profile_versions"."reporting_manager_username","user_profile_versions"."reporting_manager_name")=0)
      or ("user_profile_versions"."reporting_manager_id" is not null and num_nonnulls("user_profile_versions"."reporting_manager_username","user_profile_versions"."reporting_manager_name")=2))
    and ("user_profile_versions"."employee_code_provided" or "user_profile_versions"."phone_provided" or "user_profile_versions"."designation_provided" or "user_profile_versions"."can_manage_people_provided"
      or "user_profile_versions"."business_unit_provided" or "user_profile_versions"."default_role_provided" or "user_profile_versions"."laboratory_provided" or "user_profile_versions"."reporting_manager_provided" or "user_profile_versions"."roles_provided"))
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_code" text,
	"phone" text,
	"designation" text,
	"can_manage_people" boolean NOT NULL,
	"business_unit_id" uuid,
	"default_role_id" uuid NOT NULL,
	"laboratory_id" uuid NOT NULL,
	"reporting_manager_id" uuid,
	"revision" integer NOT NULL,
	CONSTRAINT "user_profile_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "user_profile_fields" CHECK (("user_profiles"."employee_code" is null or length("user_profiles"."employee_code") between 1 and 100)
  and ("user_profiles"."phone" is null or length("user_profiles"."phone") between 1 and 50) and ("user_profiles"."designation" is null or length("user_profiles"."designation") between 1 and 150)
  and "user_profiles"."reporting_manager_id" is distinct from "user_profiles"."user_id"),
	CONSTRAINT "user_profile_revision" CHECK ("user_profiles"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_version_roles" ADD CONSTRAINT "user_profile_version_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_version_roles" ADD CONSTRAINT "user_profile_version_role_parent_fk" FOREIGN KEY ("organization_id","user_id","revision") REFERENCES "public"."user_profile_versions"("organization_id","user_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_version_roles" ADD CONSTRAINT "user_profile_version_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_version_roles" ADD CONSTRAINT "user_profile_observed_role_version_fk" FOREIGN KEY ("organization_id","role_id","recorded_role_revision") REFERENCES "public"."role_versions"("organization_id","role_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_version_head_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."user_profiles"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_version_manager_fk" FOREIGN KEY ("organization_id","reporting_manager_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_version_unit_fk" FOREIGN KEY ("organization_id","business_unit_id") REFERENCES "public"."business_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_version_lab_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_version_default_fk" FOREIGN KEY ("organization_id","default_role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profile_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profile_manager_fk" FOREIGN KEY ("organization_id","reporting_manager_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profile_unit_fk" FOREIGN KEY ("organization_id","business_unit_id") REFERENCES "public"."business_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profile_lab_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profile_default_assignment_fk" FOREIGN KEY ("organization_id","user_id","default_role_id") REFERENCES "public"."membership_roles"("organization_id","user_id","role_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_units_code_key" ON "business_units" USING btree ("organization_id",lower("code"));
--> statement-breakpoint
CREATE FUNCTION users_require_manager() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF public.users_directory_organization() IS NULL OR NOT public.app_has_permission('users.manage') THEN
    RAISE EXCEPTION 'Active user management session required' USING ERRCODE='42501',CONSTRAINT='user_profile_session_required';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION users_write_profile(target uuid,expected_revision integer,requested_id uuid,
  employee_code_value text,employee_code_provided boolean,phone_value text,phone_provided boolean,
  designation_value text,designation_provided boolean,can_manage_value boolean,can_manage_provided boolean,
  unit_value uuid,unit_provided boolean,default_role_value uuid,default_role_provided boolean,
  laboratory_value uuid,laboratory_provided boolean,manager_value uuid,manager_provided boolean,selected_roles uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid;
  head public.user_profiles; prior public.user_profile_versions; next_profile public.user_profiles;
  next_roles uuid[]; next_revision integer; protected_permission text; locked_head_revision integer; observed_manager uuid;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR requested_id IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646
    OR num_nulls(employee_code_provided,phone_provided,designation_provided,can_manage_provided,unit_provided,default_role_provided,laboratory_provided,manager_provided)>0
    OR NOT (employee_code_provided OR phone_provided OR designation_provided OR can_manage_provided OR unit_provided OR default_role_provided OR laboratory_provided OR manager_provided OR selected_roles IS NOT NULL)
    OR (NOT employee_code_provided AND employee_code_value IS NOT NULL) OR (employee_code_value IS NOT NULL AND (length(employee_code_value) NOT BETWEEN 1 AND 100 OR employee_code_value<>trim(employee_code_value)))
    OR (NOT phone_provided AND phone_value IS NOT NULL) OR (phone_value IS NOT NULL AND (length(phone_value) NOT BETWEEN 1 AND 50 OR phone_value<>trim(phone_value)))
    OR (NOT designation_provided AND designation_value IS NOT NULL) OR (designation_value IS NOT NULL AND (length(designation_value) NOT BETWEEN 1 AND 150 OR designation_value<>trim(designation_value)))
    OR (can_manage_provided<>(can_manage_value IS NOT NULL)) OR (NOT unit_provided AND unit_value IS NOT NULL)
    OR (default_role_provided<>(default_role_value IS NOT NULL)) OR (laboratory_provided<>(laboratory_value IS NOT NULL))
    OR (NOT manager_provided AND manager_value IS NOT NULL)
    OR (selected_roles IS NOT NULL AND (array_ndims(selected_roles) IS DISTINCT FROM 1 OR cardinality(selected_roles) NOT BETWEEN 1 AND 100
      OR cardinality(selected_roles)<>(SELECT count(DISTINCT role_id) FROM unnest(selected_roles) role_id))) THEN
    RAISE EXCEPTION 'Invalid membership profile command' USING ERRCODE='23514',CONSTRAINT='user_profile_invalid_input';
  END IF;
  -- Scope is checked before locking global identities. Keep the same user-before-organization order as sign-in/password changes.
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  IF manager_value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=manager_value) THEN
    RAISE EXCEPTION 'Reporting manager is unavailable' USING ERRCODE='23514',CONSTRAINT='user_profile_manager_unavailable';
  END IF;
  SELECT * INTO head FROM public.user_profiles WHERE organization_id=org AND user_id=target;
  locked_head_revision:=coalesce(head.revision,0);
  observed_manager:=CASE WHEN manager_provided THEN manager_value ELSE head.reporting_manager_id END;
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,target,observed_manager]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,target,observed_manager]) ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  -- Compare the actual sparse command, including its explicit role set, before current reference availability/revision checks.
  SELECT * INTO prior FROM public.user_profile_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF prior.user_id<>target OR prior.saved_by<>actor OR coalesce(prior.previous_revision,0)<>expected_revision
      OR (prior.employee_code_provided,prior.phone_provided,prior.designation_provided,prior.can_manage_people_provided,prior.business_unit_provided,
        prior.default_role_provided,prior.laboratory_provided,prior.reporting_manager_provided,prior.roles_provided)
        IS DISTINCT FROM (employee_code_provided,phone_provided,designation_provided,can_manage_provided,unit_provided,default_role_provided,laboratory_provided,manager_provided,selected_roles IS NOT NULL)
      OR (employee_code_provided AND prior.employee_code IS DISTINCT FROM employee_code_value)
      OR (phone_provided AND prior.phone IS DISTINCT FROM phone_value) OR (designation_provided AND prior.designation IS DISTINCT FROM designation_value)
      OR (can_manage_provided AND prior.can_manage_people IS DISTINCT FROM can_manage_value)
      OR (unit_provided AND prior.business_unit_id IS DISTINCT FROM unit_value) OR (default_role_provided AND prior.default_role_id IS DISTINCT FROM default_role_value)
      OR (laboratory_provided AND prior.laboratory_id IS DISTINCT FROM laboratory_value) OR (manager_provided AND prior.reporting_manager_id IS DISTINCT FROM manager_value)
      OR (selected_roles IS NOT NULL AND ARRAY(SELECT role_id FROM unnest(selected_roles) role_id ORDER BY role_id)
        IS DISTINCT FROM ARRAY(SELECT role_id FROM public.user_profile_version_roles WHERE organization_id=org AND user_id=target AND revision=prior.revision AND explicitly_selected ORDER BY role_id)) THEN
      RAISE EXCEPTION 'Save request already used for a different profile change' USING ERRCODE='23514',CONSTRAINT='user_profile_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO head FROM public.user_profiles WHERE organization_id=org AND user_id=target FOR UPDATE;
  IF coalesce(head.revision,0)<>expected_revision OR coalesce(head.revision,0)<>locked_head_revision THEN
    RAISE EXCEPTION 'Profile changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='user_profile_stale';
  END IF;
  IF head.user_id IS NULL AND NOT (default_role_provided AND laboratory_provided) THEN
    RAISE EXCEPTION 'Choose a default role and laboratory for this profile' USING ERRCODE='23514',CONSTRAINT='user_profile_initial_references';
  END IF;
  next_profile:=head; next_revision:=expected_revision+1;
  next_profile.employee_code:=CASE WHEN employee_code_provided THEN employee_code_value ELSE head.employee_code END;
  next_profile.phone:=CASE WHEN phone_provided THEN phone_value ELSE head.phone END;
  next_profile.designation:=CASE WHEN designation_provided THEN designation_value ELSE head.designation END;
  next_profile.can_manage_people:=CASE WHEN can_manage_provided THEN can_manage_value ELSE coalesce(head.can_manage_people,false) END;
  next_profile.business_unit_id:=CASE WHEN unit_provided THEN unit_value ELSE head.business_unit_id END;
  next_profile.default_role_id:=CASE WHEN default_role_provided THEN default_role_value ELSE head.default_role_id END;
  next_profile.laboratory_id:=CASE WHEN laboratory_provided THEN laboratory_value ELSE head.laboratory_id END;
  next_profile.reporting_manager_id:=CASE WHEN manager_provided THEN manager_value ELSE head.reporting_manager_id END;
  -- Source form preserves hidden assignments and always adds its explicitly chosen default role.
  next_roles:=ARRAY(SELECT role_id FROM (
    SELECT unnest(coalesce(selected_roles,ARRAY(SELECT role_id FROM public.membership_roles WHERE organization_id=org AND user_id=target))) AS role_id
    UNION SELECT next_profile.default_role_id) selected ORDER BY role_id);
  IF next_profile.reporting_manager_id=target THEN
    RAISE EXCEPTION 'A user cannot report to themselves' USING ERRCODE='23514',CONSTRAINT='user_profile_own_manager';
  END IF;
  -- Lock even omitted references while observing their current labels. Availability checks below apply only to explicit selections.
  PERFORM 1 FROM public.business_units WHERE organization_id=org AND id=next_profile.business_unit_id FOR SHARE;
  PERFORM 1 FROM public.laboratories WHERE organization_id=org AND id=next_profile.laboratory_id FOR SHARE;
  IF unit_provided AND unit_value IS NOT NULL THEN
    PERFORM 1 FROM public.business_units WHERE organization_id=org AND id=unit_value AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Business unit is unavailable' USING ERRCODE='23514',CONSTRAINT='user_profile_unit_unavailable'; END IF;
  END IF;
  IF laboratory_provided THEN
    PERFORM 1 FROM public.laboratories WHERE organization_id=org AND id=laboratory_value AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Laboratory is unavailable' USING ERRCODE='23514',CONSTRAINT='user_profile_lab_unavailable'; END IF;
  END IF;
  IF manager_provided AND manager_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id AND person.active
    WHERE membership.organization_id=org AND membership.user_id=manager_value AND membership.active) THEN
    RAISE EXCEPTION 'Reporting manager is unavailable' USING ERRCODE='23514',CONSTRAINT='user_profile_manager_unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(selected_roles,ARRAY[]::uuid[]) || CASE WHEN default_role_provided THEN ARRAY[default_role_value] ELSE ARRAY[]::uuid[] END) candidate(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.roles role WHERE role.organization_id=org AND role.id=candidate.id AND role.active)) THEN
    RAISE EXCEPTION 'Select active roles in this organization' USING ERRCODE='23514',CONSTRAINT='user_profile_role_unavailable';
  END IF;
  -- Match role management's organization lock and retain each existing administration capability.
  FOREACH protected_permission IN ARRAY ARRAY['roles.manage','users.manage'] LOOP
    IF EXISTS (
      SELECT 1 FROM public.membership_roles assignment JOIN public.roles role ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id AND role.active
      JOIN public.memberships membership ON membership.organization_id=assignment.organization_id AND membership.user_id=assignment.user_id AND membership.active
      JOIN public.users person ON person.id=membership.user_id AND person.active
      JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code=protected_permission
      WHERE assignment.organization_id=org
    ) AND NOT EXISTS (
      SELECT 1 FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id AND person.active
      JOIN public.roles role ON role.organization_id=membership.organization_id AND role.active
      JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code=protected_permission
      WHERE membership.organization_id=org AND membership.active AND
        ((membership.user_id=target AND role.id=ANY(next_roles)) OR (membership.user_id<>target AND EXISTS
          (SELECT 1 FROM public.membership_roles assignment WHERE assignment.organization_id=org AND assignment.user_id=membership.user_id AND assignment.role_id=role.id)))
    ) THEN RAISE EXCEPTION 'The last active administrator must be retained' USING ERRCODE='23514',CONSTRAINT='user_profile_last_administrator'; END IF;
  END LOOP;
  INSERT INTO public.membership_roles(organization_id,user_id,role_id)
    SELECT org,target,candidate.id FROM unnest(next_roles) candidate(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.membership_roles assignment WHERE assignment.organization_id=org AND assignment.user_id=target AND assignment.role_id=candidate.id);
  IF head.user_id IS NULL THEN
    INSERT INTO public.user_profiles(organization_id,user_id,revision,employee_code,phone,designation,can_manage_people,business_unit_id,default_role_id,laboratory_id,reporting_manager_id)
      VALUES(org,target,next_revision,next_profile.employee_code,next_profile.phone,next_profile.designation,next_profile.can_manage_people,
        next_profile.business_unit_id,next_profile.default_role_id,next_profile.laboratory_id,next_profile.reporting_manager_id);
  ELSE
    UPDATE public.user_profiles SET revision=next_revision,employee_code=next_profile.employee_code,phone=next_profile.phone,
      designation=next_profile.designation,can_manage_people=next_profile.can_manage_people,business_unit_id=next_profile.business_unit_id,
      default_role_id=next_profile.default_role_id,laboratory_id=next_profile.laboratory_id,reporting_manager_id=next_profile.reporting_manager_id
      WHERE organization_id=org AND user_id=target;
  END IF;
  INSERT INTO public.user_profile_versions(organization_id,user_id,revision,previous_revision,request_id,employee_code,phone,designation,can_manage_people,
    business_unit_id,default_role_id,laboratory_id,reporting_manager_id,employee_code_provided,phone_provided,designation_provided,can_manage_people_provided,
    business_unit_provided,default_role_provided,laboratory_provided,reporting_manager_provided,roles_provided,
    business_unit_code,business_unit_name,laboratory_code,laboratory_name,reporting_manager_username,reporting_manager_name,
    role_count,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,next_revision,nullif(expected_revision,0),requested_id,next_profile.employee_code,next_profile.phone,next_profile.designation,next_profile.can_manage_people,
      next_profile.business_unit_id,next_profile.default_role_id,next_profile.laboratory_id,next_profile.reporting_manager_id,
      employee_code_provided,phone_provided,designation_provided,can_manage_provided,unit_provided,default_role_provided,laboratory_provided,manager_provided,selected_roles IS NOT NULL,
      unit.code,unit.name,lab.code,lab.name,manager.username,manager.display_name,cardinality(next_roles),actor,editor.username,editor.display_name
    FROM public.users editor JOIN public.laboratories lab ON lab.organization_id=org AND lab.id=next_profile.laboratory_id
    LEFT JOIN public.business_units unit ON unit.organization_id=org AND unit.id=next_profile.business_unit_id
    LEFT JOIN public.users manager ON manager.id=next_profile.reporting_manager_id WHERE editor.id=actor;
  INSERT INTO public.user_profile_version_roles(organization_id,user_id,revision,role_id,recorded_role_revision,name,description,active,explicitly_selected)
    SELECT org,target,next_revision,role.id,nullif(role.revision,0),role.name,role.description,role.active,coalesce(role.id=ANY(selected_roles),false)
    FROM public.roles role WHERE role.organization_id=org AND role.id=ANY(next_roles);
  -- The head's default assignment now exists. Removing old roles last also permits a successful self-permission change.
  DELETE FROM public.membership_roles WHERE organization_id=org AND user_id=target AND NOT role_id=ANY(next_roles);
  RETURN next_revision;
END $$;

--> statement-breakpoint
CREATE FUNCTION users_guard_profile_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recorded profiles cannot be deleted' USING ERRCODE='55000'; END IF;
  PERFORM public.users_require_manager();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR (TG_OP='INSERT' AND NEW.revision<>1)
    OR (TG_OP='UPDATE' AND ((NEW.organization_id,NEW.user_id) IS DISTINCT FROM (OLD.organization_id,OLD.user_id) OR NEW.revision<>OLD.revision+1)) THEN
    RAISE EXCEPTION 'Profile identity and consecutive revisions are required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION users_guard_profile_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.user_profiles; version public.user_profile_versions; role public.roles;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'User profile history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='user_profile_versions' THEN
    SELECT * INTO head FROM public.user_profiles WHERE organization_id=NEW.organization_id AND user_id=NEW.user_id;
    IF NEW.saved_by IS DISTINCT FROM public.users_require_manager()
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (NEW.revision,NEW.employee_code,NEW.phone,NEW.designation,NEW.can_manage_people,NEW.business_unit_id,NEW.default_role_id,NEW.laboratory_id,NEW.reporting_manager_id)
        IS DISTINCT FROM (head.revision,head.employee_code,head.phone,head.designation,head.can_manage_people,head.business_unit_id,head.default_role_id,head.laboratory_id,head.reporting_manager_id)
      OR NOT EXISTS (SELECT 1 FROM public.users editor JOIN public.laboratories lab ON lab.organization_id=NEW.organization_id AND lab.id=NEW.laboratory_id
        LEFT JOIN public.business_units unit ON unit.organization_id=NEW.organization_id AND unit.id=NEW.business_unit_id
        LEFT JOIN public.users manager ON manager.id=NEW.reporting_manager_id
        WHERE editor.id=NEW.saved_by AND
          (NEW.saved_by_username,NEW.saved_by_name,NEW.laboratory_code,NEW.laboratory_name,NEW.business_unit_code,NEW.business_unit_name,NEW.reporting_manager_username,NEW.reporting_manager_name)
          IS NOT DISTINCT FROM (editor.username,editor.display_name,lab.code,lab.name,unit.code,unit.name,manager.username,manager.display_name)) THEN
      RAISE EXCEPTION 'History requires the actual profile, actor, reference observations and save transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.user_profile_versions WHERE organization_id=NEW.organization_id AND user_id=NEW.user_id AND revision=NEW.revision;
    SELECT * INTO role FROM public.roles WHERE organization_id=NEW.organization_id AND id=NEW.role_id;
    IF version.user_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR (NEW.recorded_role_revision,NEW.name,NEW.description,NEW.active) IS DISTINCT FROM (nullif(role.revision,0),role.name,role.description,role.active)
      OR (NEW.explicitly_selected AND NOT version.roles_provided) THEN
      RAISE EXCEPTION 'Role observations require their actual profile revision transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION users_assert_profile(org uuid,target uuid,target_revision integer,check_head boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.user_profile_versions; head public.user_profiles; role_ids uuid[]; selected_count integer;
BEGIN
  SELECT * INTO version FROM public.user_profile_versions WHERE organization_id=org AND user_id=target AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile revision is missing' USING ERRCODE='23514'; END IF;
  SELECT array_agg(role_id ORDER BY role_id),count(*) FILTER (WHERE explicitly_selected)::integer INTO role_ids,selected_count
    FROM public.user_profile_version_roles WHERE organization_id=org AND user_id=target AND revision=target_revision;
  IF coalesce(cardinality(role_ids),0)<>version.role_count OR NOT version.default_role_id=ANY(role_ids)
    OR (version.roles_provided AND selected_count NOT BETWEEN 1 AND 100) OR (NOT version.roles_provided AND selected_count<>0)
    OR (version.previous_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_profile_versions
      WHERE organization_id=org AND user_id=target AND revision=version.previous_revision)) THEN
    RAISE EXCEPTION 'Profile history requires its prior revision and complete role observations' USING ERRCODE='23514';
  END IF;
  IF check_head THEN
    SELECT * INTO head FROM public.user_profiles WHERE organization_id=org AND user_id=target;
    IF (head.revision,head.employee_code,head.phone,head.designation,head.can_manage_people,head.business_unit_id,head.default_role_id,head.laboratory_id,head.reporting_manager_id)
      IS DISTINCT FROM (version.revision,version.employee_code,version.phone,version.designation,version.can_manage_people,version.business_unit_id,version.default_role_id,version.laboratory_id,version.reporting_manager_id)
      OR role_ids IS DISTINCT FROM ARRAY(SELECT role_id FROM public.membership_roles WHERE organization_id=org AND user_id=target ORDER BY role_id) THEN
      RAISE EXCEPTION 'Current profile and role assignments must match their saved revision' USING ERRCODE='23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION users_check_profile_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; target uuid; head_revision integer;
BEGIN
  org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  SELECT revision INTO head_revision FROM public.user_profiles WHERE organization_id=org AND user_id=target;
  IF TG_TABLE_NAME='membership_roles' THEN
    -- A profile write already schedules full head/version assertions. Do not rescan the full role set once per assignment.
    IF head_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_profile_versions
      WHERE organization_id=org AND user_id=target AND revision=head_revision AND created_transaction_id=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Role assignments require a new profile revision' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='user_profile_versions' THEN
    PERFORM public.users_assert_profile(org,target,NEW.revision,head_revision=NEW.revision);
  ELSIF head_revision IS NOT NULL THEN PERFORM public.users_assert_profile(org,target,head_revision,true); END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER business_unit_revision_guard BEFORE UPDATE ON business_units FOR EACH ROW EXECUTE FUNCTION laboratory_guard_master_revision();

CREATE TRIGGER user_profile_head_guard BEFORE INSERT OR UPDATE OR DELETE ON user_profiles FOR EACH ROW EXECUTE FUNCTION users_guard_profile_head();
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['user_profile_versions','user_profile_version_roles'] LOOP
    EXECUTE format('CREATE TRIGGER user_profile_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION users_guard_profile_history()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['user_profiles','user_profile_versions','membership_roles'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER user_profile_complete AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_check_profile_complete()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['business_units','user_profiles','user_profile_versions','user_profile_version_roles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
  END LOOP;
END $$;

CREATE VIEW user_profile_heads WITH (security_barrier=true,security_invoker=false) AS
  SELECT profile.* FROM public.user_profiles profile WHERE profile.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_profile_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT version.* FROM public.user_profile_versions version WHERE version.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_profile_role_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT role.* FROM public.user_profile_version_roles role WHERE role.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_profile_references WITH (security_barrier=true,security_invoker=false) AS
  WITH scope AS MATERIALIZED (SELECT public.users_directory_organization() AS id)
  SELECT role.organization_id,'roles'::text AS kind,role.id,role.name,role.description,role.active,NULL::text AS code FROM public.roles role JOIN scope ON scope.id=role.organization_id
  UNION ALL SELECT unit.organization_id,'businessUnits',unit.id,unit.name,unit.description,unit.active,unit.code FROM public.business_units unit JOIN scope ON scope.id=unit.organization_id
  UNION ALL SELECT lab.organization_id,'laboratories',lab.id,lab.name,NULL,lab.active,lab.code FROM public.laboratories lab JOIN scope ON scope.id=lab.organization_id
  UNION ALL SELECT membership.organization_id,'managers',person.id,person.display_name,NULL,person.active AND membership.active,person.username
    FROM public.memberships membership JOIN scope ON scope.id=membership.organization_id JOIN public.users person ON person.id=membership.user_id;
REVOKE ALL ON user_profile_heads,user_profile_history,user_profile_role_history,user_profile_references FROM PUBLIC;
GRANT SELECT ON user_profile_heads,user_profile_history,user_profile_role_history,user_profile_references TO sampleify_app;
REVOKE ALL ON FUNCTION users_require_manager(),users_guard_profile_head(),users_guard_profile_history(),users_assert_profile(uuid,uuid,integer,boolean),users_check_profile_complete(),
  users_write_profile(uuid,integer,uuid,text,boolean,text,boolean,text,boolean,boolean,boolean,uuid,boolean,uuid,boolean,uuid,boolean,uuid,boolean,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_write_profile(uuid,integer,uuid,text,boolean,text,boolean,text,boolean,boolean,boolean,uuid,boolean,uuid,boolean,uuid,boolean,uuid,boolean,uuid[]) TO sampleify_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION roles_write(operation text,target uuid,expected_revision integer,requested_id uuid,requested_name text,
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
  -- User administration must remain available when role definitions and assignments change concurrently.
  IF EXISTS (
    SELECT 1 FROM public.membership_roles assignment JOIN public.roles role ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id AND role.active
    JOIN public.memberships membership ON membership.organization_id=assignment.organization_id AND membership.user_id=assignment.user_id AND membership.active
    JOIN public.users person ON person.id=membership.user_id AND person.active
    JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code='users.manage'
    WHERE assignment.organization_id=org
  ) AND NOT EXISTS (
    SELECT 1 FROM public.membership_roles assignment JOIN public.roles role ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id AND role.active
    JOIN public.memberships membership ON membership.organization_id=assignment.organization_id AND membership.user_id=assignment.user_id AND membership.active
    JOIN public.users person ON person.id=membership.user_id AND person.active
    JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code='users.manage'
    WHERE assignment.organization_id=org AND (role.id<>target OR (operation<>'retire' AND 'users.manage'=ANY(next_permissions)))
  ) THEN RAISE EXCEPTION 'The last active user administrator must be retained' USING ERRCODE='23514',CONSTRAINT='user_profile_last_administrator'; END IF;
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
