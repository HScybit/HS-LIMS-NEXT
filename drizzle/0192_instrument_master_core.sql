CREATE TABLE "instrument_files" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_file_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "instrument_file_values" CHECK (length("instrument_files"."original_name") between 1 and 500 and "instrument_files"."original_name"=trim("instrument_files"."original_name")
    and "instrument_files"."original_name" !~ '[[:cntrl:]]' and position('/' in "instrument_files"."original_name")=0 and position(chr(92) in "instrument_files"."original_name")=0
    and length("instrument_files"."media_type") between 1 and 255 and "instrument_files"."media_type"=lower("instrument_files"."media_type")
    and "instrument_files"."media_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    and "instrument_files"."byte_length" between 0 and 26214400 and "instrument_files"."byte_length"=octet_length("instrument_files"."content") and "instrument_files"."sha256"=encode(sha256("instrument_files"."content"),'hex'))
);

--> statement-breakpoint
CREATE TABLE "instrument_version_service_roles" (
	"organization_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"service_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role_name" text NOT NULL,
	CONSTRAINT "instrument_service_role_pk" PRIMARY KEY("organization_id","instrument_id","revision","service_id","role_id"),
	CONSTRAINT "instrument_service_role_position" UNIQUE("organization_id","instrument_id","revision","service_id","position"),
	CONSTRAINT "instrument_service_role_order" CHECK ("instrument_version_service_roles"."position" between 0 and 499)
);

--> statement-breakpoint
CREATE TABLE "instrument_version_services" (
	"organization_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"service_definition_id" uuid NOT NULL,
	"service_definition_revision" integer NOT NULL,
	"service_code" text NOT NULL,
	"service_label" text NOT NULL,
	"template_id" uuid,
	"workflow_id" uuid,
	"template_name" text,
	"workflow_name" text,
	"reminder_before_days" integer NOT NULL,
	"frequency_days" integer,
	"last_performed_on" date,
	"reminder_frequency_days" integer,
	"next_reminder_on" date,
	"active" boolean NOT NULL,
	"role_count" integer NOT NULL,
	CONSTRAINT "instrument_version_service_pk" PRIMARY KEY("organization_id","instrument_id","revision","id"),
	CONSTRAINT "instrument_version_service_position" UNIQUE("organization_id","instrument_id","revision","position"),
	CONSTRAINT "instrument_version_service_code" UNIQUE("organization_id","instrument_id","revision","service_code"),
	CONSTRAINT "instrument_service_values" CHECK ("instrument_version_services"."position" between 0 and 99 and "instrument_version_services"."role_count" between 0 and 500 and "instrument_version_services"."reminder_before_days" between 0 and 3650
    and ("instrument_version_services"."frequency_days" is null or "instrument_version_services"."frequency_days" between 1 and 36500) and ("instrument_version_services"."reminder_frequency_days" is null or "instrument_version_services"."reminder_frequency_days" between 1 and 3650)
    and ("instrument_version_services"."last_performed_on" is null or "instrument_version_services"."last_performed_on" between date '0001-01-01' and date '9999-12-31')
    and ("instrument_version_services"."next_reminder_on" is null or "instrument_version_services"."next_reminder_on" between date '0001-01-01' and date '9999-12-31')
    and (("instrument_version_services"."template_id" is null)=("instrument_version_services"."workflow_id" is null)) and ("instrument_version_services"."template_id" is null or "instrument_version_services"."role_count">0))
);

--> statement-breakpoint
CREATE TABLE "instrument_version_users" (
	"organization_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"user_name" text NOT NULL,
	"username" text NOT NULL,
	CONSTRAINT "instrument_version_user_pk" PRIMARY KEY("organization_id","instrument_id","revision","user_id"),
	CONSTRAINT "instrument_version_user_position" UNIQUE("organization_id","instrument_id","revision","position"),
	CONSTRAINT "instrument_version_user_order" CHECK ("instrument_version_users"."position" between 0 and 499)
);

--> statement-breakpoint
CREATE TABLE "instrument_versions" (
	"organization_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"laboratory_id" uuid,
	"make" text,
	"model_name" text,
	"serial_number" text,
	"date_of_installation" date,
	"calibration_agency" text,
	"calibrated" boolean DEFAULT true NOT NULL,
	"cost_of_equipment" numeric(18, 2),
	"purchase_file_id" uuid,
	"current_location" text,
	"manufacturer_supplier" text,
	"active" boolean DEFAULT true NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"current_status" text DEFAULT 'is_working' NOT NULL,
	"laboratory_name" text,
	"request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"user_count" integer NOT NULL,
	"service_count" integer NOT NULL,
	"users_provided" boolean NOT NULL,
	"services_provided" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "instrument_version_pk" PRIMARY KEY("organization_id","instrument_id","revision"),
	CONSTRAINT "instrument_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "instrument_version_values" CHECK (length(trim("instrument_versions"."code")) between 1 and 64 and "instrument_versions"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim("instrument_versions"."name")) between 1 and 200 and ("instrument_versions"."description" is null or length("instrument_versions"."description")<=5000)
  and ("instrument_versions"."make" is null or length("instrument_versions"."make")<=200) and ("instrument_versions"."model_name" is null or length("instrument_versions"."model_name")<=200)
  and ("instrument_versions"."serial_number" is null or length("instrument_versions"."serial_number")<=200) and ("instrument_versions"."calibration_agency" is null or length("instrument_versions"."calibration_agency")<=250)
  and ("instrument_versions"."current_location" is null or length("instrument_versions"."current_location")<=250) and ("instrument_versions"."manufacturer_supplier" is null or length("instrument_versions"."manufacturer_supplier")<=250)
  and ("instrument_versions"."date_of_installation" is null or "instrument_versions"."date_of_installation" between date '0001-01-01' and date '9999-12-31')
  and ("instrument_versions"."cost_of_equipment" is null or ("instrument_versions"."cost_of_equipment">=0 and "instrument_versions"."cost_of_equipment" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)))
  and "instrument_versions"."status" in ('available','in_use','maintenance','out_of_service','retired') and "instrument_versions"."current_status" in ('is_working','in_breakdown')
  and (not "instrument_versions"."retired" or not "instrument_versions"."active") and ("instrument_versions"."active" or "instrument_versions"."status"='retired')),
	CONSTRAINT "instrument_version_revision" CHECK (("instrument_versions"."operation"='create' and "instrument_versions"."previous_revision" is null and "instrument_versions"."revision"=1)
    or ("instrument_versions"."operation" in ('update','retire') and "instrument_versions"."previous_revision">0 and "instrument_versions"."previous_revision" is not null and "instrument_versions"."revision"="instrument_versions"."previous_revision"+1)),
	CONSTRAINT "instrument_version_command" CHECK ("instrument_versions"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "instrument_versions"."user_count" between 1 and 500 and "instrument_versions"."service_count" between 0 and 100
    and ("instrument_versions"."retired"=("instrument_versions"."operation"='retire')) and ("instrument_versions"."operation"<>'retire' or (not "instrument_versions"."users_provided" and not "instrument_versions"."services_provided")))
);

--> statement-breakpoint
CREATE TABLE "instruments" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"laboratory_id" uuid,
	"make" text,
	"model_name" text,
	"serial_number" text,
	"date_of_installation" date,
	"calibration_agency" text,
	"calibrated" boolean DEFAULT true NOT NULL,
	"cost_of_equipment" numeric(18, 2),
	"purchase_file_id" uuid,
	"current_location" text,
	"manufacturer_supplier" text,
	"active" boolean DEFAULT true NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"current_status" text DEFAULT 'is_working' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"save_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "instruments_code_key" UNIQUE("organization_id","code"),
	CONSTRAINT "instrument_values" CHECK (length(trim("instruments"."code")) between 1 and 64 and "instruments"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim("instruments"."name")) between 1 and 200 and ("instruments"."description" is null or length("instruments"."description")<=5000)
  and ("instruments"."make" is null or length("instruments"."make")<=200) and ("instruments"."model_name" is null or length("instruments"."model_name")<=200)
  and ("instruments"."serial_number" is null or length("instruments"."serial_number")<=200) and ("instruments"."calibration_agency" is null or length("instruments"."calibration_agency")<=250)
  and ("instruments"."current_location" is null or length("instruments"."current_location")<=250) and ("instruments"."manufacturer_supplier" is null or length("instruments"."manufacturer_supplier")<=250)
  and ("instruments"."date_of_installation" is null or "instruments"."date_of_installation" between date '0001-01-01' and date '9999-12-31')
  and ("instruments"."cost_of_equipment" is null or ("instruments"."cost_of_equipment">=0 and "instruments"."cost_of_equipment" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)))
  and "instruments"."status" in ('available','in_use','maintenance','out_of_service','retired') and "instruments"."current_status" in ('is_working','in_breakdown')
  and (not "instruments"."retired" or not "instruments"."active") and ("instruments"."active" or "instruments"."status"='retired')),
	CONSTRAINT "instrument_revision" CHECK ("instruments"."revision">0)
);

--> statement-breakpoint
ALTER TABLE "workflow_metadata_versions" DROP CONSTRAINT "workflow_metadata_history_fields";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflow_metadata";
--> statement-breakpoint
ALTER TABLE "instrument_files" ADD CONSTRAINT "instrument_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_files" ADD CONSTRAINT "instrument_file_actor_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_service_roles" ADD CONSTRAINT "instrument_version_service_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_service_roles" ADD CONSTRAINT "instrument_service_role_parent_fk" FOREIGN KEY ("organization_id","instrument_id","revision","service_id") REFERENCES "public"."instrument_version_services"("organization_id","instrument_id","revision","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_service_roles" ADD CONSTRAINT "instrument_service_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_services" ADD CONSTRAINT "instrument_version_services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_services" ADD CONSTRAINT "instrument_version_service_parent_fk" FOREIGN KEY ("organization_id","instrument_id","revision") REFERENCES "public"."instrument_versions"("organization_id","instrument_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_services" ADD CONSTRAINT "instrument_service_definition_fk" FOREIGN KEY ("organization_id","service_definition_revision","service_definition_id") REFERENCES "public"."organization_instrument_service_entries"("organization_id","revision","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_services" ADD CONSTRAINT "instrument_service_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_services" ADD CONSTRAINT "instrument_service_workflow_fk" FOREIGN KEY ("organization_id","workflow_id") REFERENCES "public"."workflows"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_users" ADD CONSTRAINT "instrument_version_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_users" ADD CONSTRAINT "instrument_version_user_parent_fk" FOREIGN KEY ("organization_id","instrument_id","revision") REFERENCES "public"."instrument_versions"("organization_id","instrument_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_users" ADD CONSTRAINT "instrument_version_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_version_parent_fk" FOREIGN KEY ("organization_id","instrument_id") REFERENCES "public"."instruments"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_version_lab_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_version_purchase_file_fk" FOREIGN KEY ("organization_id","purchase_file_id") REFERENCES "public"."instrument_files"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instrument_lab_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instrument_purchase_file_fk" FOREIGN KEY ("organization_id","purchase_file_id") REFERENCES "public"."instrument_files"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "instrument_listing" ON "instruments" USING btree ("organization_id","created_at","id") WHERE not "instruments"."retired";
--> statement-breakpoint
ALTER TABLE "workflow_metadata_versions" ADD CONSTRAINT "workflow_metadata_history_fields" CHECK (length(trim("workflow_metadata_versions"."code")) between 1 and 64 and length(trim("workflow_metadata_versions"."name")) between 1 and 200
    and "workflow_metadata_versions"."applies_to" in ('sample','test_request','instrument_service') and ("workflow_metadata_versions"."requested_applies_to" is null or "workflow_metadata_versions"."requested_applies_to" in ('sample','test_request','instrument_service'))
    and (not "workflow_metadata_versions"."generated_code" or ("workflow_metadata_versions"."operation"='create' and "workflow_metadata_versions"."requested_code" is not null))
    and ("workflow_metadata_versions"."operation"<>'retire' or (not "workflow_metadata_versions"."active" and not "workflow_metadata_versions"."description_provided" and not "workflow_metadata_versions"."generated_code"
      and num_nonnulls("workflow_metadata_versions"."requested_code","workflow_metadata_versions"."requested_applies_to","workflow_metadata_versions"."requested_active")=0)));
--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflow_metadata" CHECK (length(trim("workflows"."code")) between 1 and 64 and length(trim("workflows"."name")) between 1 and 200 and "workflows"."applies_to" in ('sample', 'test_request', 'instrument_service'));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION workflows_metadata_write(operation text,target uuid,expected_revision integer,requested_id uuid,requested_name text,
  requested_description text,description_provided boolean,requested_code text,generate_code boolean,requested_type text,requested_active boolean)
RETURNS TABLE(metadata_revision integer,initial_version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; head public.workflows;
  prior public.workflow_metadata_versions; next_revision integer; next_code text; next_name text; next_description text; next_type text; next_active boolean;
  created_version uuid; suffix integer:=2; used boolean;
BEGIN
  actor:=public.workflow_metadata_require_actor();
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  actor:=public.workflow_metadata_require_actor();
  IF operation IS NULL OR operation NOT IN ('create','update','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR (operation='create' AND expected_revision<>0)
    OR description_provided IS NULL OR generate_code IS NULL OR (generate_code AND operation<>'create')
    OR (NOT description_provided AND requested_description IS NOT NULL) OR (description_provided AND requested_description IS NULL)
    OR length(requested_description)>10000
    OR (requested_code IS NOT NULL AND (length(trim(requested_code)) NOT BETWEEN 1 AND 64 OR requested_code<>trim(requested_code)))
    OR (requested_type IS NOT NULL AND requested_type NOT IN ('sample','test_request','instrument_service'))
    OR (operation='create' AND (requested_code IS NULL OR requested_type IS NULL))
    OR (operation='retire' AND (num_nonnulls(requested_name,requested_description,requested_code,requested_type,requested_active)<>0 OR description_provided OR generate_code))
    OR (operation<>'retire' AND (requested_name IS NULL OR length(trim(requested_name)) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name))) THEN
    RAISE EXCEPTION 'Invalid workflow metadata command' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_input';
  END IF;
  SELECT * INTO prior FROM public.workflow_metadata_versions history WHERE history.organization_id=org AND history.request_id=requested_id;
  IF FOUND THEN
    IF prior.workflow_id<>target OR prior.operation<>operation OR coalesce(prior.previous_revision,0)<>expected_revision OR prior.saved_by<>actor
      OR prior.description_provided<>description_provided OR prior.generated_code<>generate_code
      OR prior.requested_code IS DISTINCT FROM requested_code OR prior.requested_applies_to IS DISTINCT FROM requested_type
      OR prior.requested_active IS DISTINCT FROM requested_active OR (operation<>'retire' AND prior.name IS DISTINCT FROM requested_name)
      OR (description_provided AND prior.description IS DISTINCT FROM requested_description) THEN
      RAISE EXCEPTION 'Workflow request was already used for a different change' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_request_reused';
    END IF;
    RETURN QUERY SELECT prior.revision,prior.initial_version_id; RETURN;
  END IF;
  SELECT * INTO head FROM public.workflows WHERE organization_id=org AND id=target FOR UPDATE;
  IF operation='create' AND FOUND THEN RAISE EXCEPTION 'Workflow already exists' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_identity_exists'; END IF;
  IF operation<>'create' AND (head.id IS NULL OR NOT head.active) THEN
    RAISE EXCEPTION 'Workflow was not found' USING ERRCODE='P0002',CONSTRAINT='workflow_metadata_not_found';
  END IF;
  IF operation<>'create' AND head.metadata_revision<>expected_revision THEN
    RAISE EXCEPTION 'Workflow details changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_stale';
  END IF;
  next_name:=CASE WHEN operation='retire' THEN head.name ELSE requested_name END;
  next_description:=CASE WHEN description_provided THEN requested_description ELSE coalesce(head.description,'') END;
  next_code:=coalesce(requested_code,head.code); next_type:=coalesce(requested_type,head.applies_to);
  next_active:=CASE WHEN operation='retire' THEN false ELSE coalesce(requested_active,head.active,true) END;
  IF next_active AND (operation='create' OR next_name IS DISTINCT FROM head.name) AND EXISTS (
    SELECT 1 FROM public.workflows WHERE organization_id=org AND id<>target AND active AND name=next_name
  ) THEN RAISE EXCEPTION 'A workflow with this name already exists' USING ERRCODE='23514',CONSTRAINT='workflow_name_exists'; END IF;
  IF generate_code THEN
    WHILE EXISTS (SELECT 1 FROM public.workflows WHERE organization_id=org AND lower(code)=lower(next_code)) LOOP
      next_code:=left(requested_code,60-length(suffix::text))||'-'||suffix::text; suffix:=suffix+1;
    END LOOP;
  END IF;
  IF operation<>'create' AND (NOT next_active OR next_type IS DISTINCT FROM head.applies_to) THEN
    SELECT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_versions version
      ON version.organization_id=run.organization_id AND version.id=run.workflow_version_id WHERE version.organization_id=org AND version.workflow_id=target)
      OR EXISTS (SELECT 1 FROM public.sample_category_workflows WHERE organization_id=org AND workflow_id=target)
      OR EXISTS (SELECT 1 FROM public.organization_laboratory_settings WHERE organization_id=org
        AND target IN (test_request_workflow_id,job_workflow_id,sample_workflow_base_id,sample_workflow_iqc_id,sample_workflow_ilc_id,sample_workflow_pt_id,sample_workflow_amendment_id,sample_workflow_complaint_id)) INTO used;
    IF used THEN
      IF NOT next_active THEN RAISE EXCEPTION 'Workflow is currently used' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_in_use';
      ELSE RAISE EXCEPTION 'Used workflow entity type is immutable' USING ERRCODE='23514',CONSTRAINT='workflow_type_in_use'; END IF;
    END IF;
  END IF;
  next_revision:=expected_revision+1;
  IF operation='create' THEN
    INSERT INTO public.workflows(organization_id,id,code,name,description,applies_to,active,metadata_revision,created_by,updated_by,updated_at)
      VALUES(org,target,next_code,next_name,next_description,next_type,next_active,next_revision,actor,actor,transaction_timestamp());
    created_version:=gen_random_uuid();
    INSERT INTO public.workflow_versions(organization_id,id,workflow_id,number,created_by,change_summary)
      VALUES(org,created_version,target,1,actor,'Initial draft');
  ELSE
    UPDATE public.workflows SET code=next_code,name=next_name,description=next_description,applies_to=next_type,active=next_active,
      metadata_revision=next_revision,updated_by=actor,updated_at=transaction_timestamp() WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.workflow_metadata_versions(organization_id,workflow_id,revision,request_id,previous_revision,operation,initial_version_id,
    code,name,description,applies_to,active,requested_code,generated_code,description_provided,requested_applies_to,requested_active,saved_by)
    VALUES(org,target,next_revision,requested_id,CASE WHEN operation='create' THEN NULL ELSE expected_revision END,operation,created_version,
      next_code,next_name,next_description,next_type,next_active,requested_code,generate_code,description_provided,requested_type,requested_active,actor);
  RETURN QUERY SELECT next_revision,created_version;
END $$;
--> statement-breakpoint
INSERT INTO permissions(code,description) VALUES ('instruments.read','View permitted instruments'),('instruments.manage','Manage instruments') ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION instruments_can_read(target_id uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.organization_module_scope() IS NOT NULL AND public.organization_has_module_access('instrument')
    AND (public.app_has_permission('instruments.read') OR public.app_has_permission('instruments.manage'))
    AND (target_id IS NULL OR EXISTS (
      SELECT 1 FROM public.instruments item WHERE item.organization_id=public.organization_module_scope() AND item.id=target_id
        AND (public.app_has_permission('instruments.manage') OR EXISTS (
          SELECT 1 FROM public.membership_roles assigned JOIN public.roles role ON role.organization_id=assigned.organization_id AND role.id=assigned.role_id
            JOIN public.role_capabilities capability ON capability.organization_id=assigned.organization_id AND capability.role_id=assigned.role_id
          WHERE assigned.organization_id=item.organization_id AND assigned.user_id=nullif(current_setting('app.user_id',true),'')::uuid
            AND role.active AND capability.capability_key='can_access_instruments_all'
        ) OR EXISTS (
          SELECT 1 FROM public.instrument_version_users allowed WHERE allowed.organization_id=item.organization_id
            AND allowed.instrument_id=item.id AND allowed.revision=item.revision AND allowed.user_id=nullif(current_setting('app.user_id',true),'')::uuid
        ))
    ));
$$;
--> statement-breakpoint
CREATE FUNCTION instruments_require_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; org uuid:=public.organization_module_scope();
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'Instrument management session required' USING ERRCODE='42501',CONSTRAINT='instrument_session_required'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
  PERFORM 1 FROM public.users WHERE id=actor FOR NO KEY UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR NO KEY UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.organization_require_module_access('instrument');
  IF NOT public.app_has_permission('instruments.manage') THEN
    RAISE EXCEPTION 'Instrument management permission required' USING ERRCODE='42501',CONSTRAINT='instrument_session_required';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_prior_request(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text,requested_operation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.instruments_require_writer(); org uuid:=public.organization_module_scope(); prior public.instrument_versions;
BEGIN
  IF target_id IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR requested_id IS NULL
    OR fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' OR requested_operation IS NULL OR requested_operation NOT IN ('create','update','retire') THEN
    RAISE EXCEPTION 'Invalid Instrument command' USING ERRCODE='23514',CONSTRAINT='instrument_command_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('instrument-save:'||org::text||':'||requested_id::text,0));
  SELECT * INTO prior FROM public.instrument_versions WHERE organization_id=org AND request_id=requested_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (prior.instrument_id,coalesce(prior.previous_revision,0),prior.operation,prior.request_fingerprint,prior.saved_by)
    IS DISTINCT FROM (target_id,expected_revision,requested_operation,fingerprint,actor) THEN
    RAISE EXCEPTION 'Instrument request was already used for another change' USING ERRCODE='23514',CONSTRAINT='instrument_request_reused';
  END IF;
  RETURN prior.revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_guard_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.instrument_versions; head public.instruments;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Instrument history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO head FROM public.instruments WHERE organization_id=NEW.organization_id AND id=NEW.instrument_id;
  IF TG_TABLE_NAME='instrument_versions' THEN version:=NEW;
  ELSE SELECT * INTO version FROM public.instrument_versions WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.revision; END IF;
  IF version.instrument_id IS NULL OR head.id IS NULL OR version.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR version.saved_at IS DISTINCT FROM transaction_timestamp() OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR head.revision IS DISTINCT FROM NEW.revision
    OR head.save_request_id IS DISTINCT FROM version.request_id THEN
    RAISE EXCEPTION 'Instrument history requires the actual saved command' USING ERRCODE='23514',CONSTRAINT='instrument_history_transaction';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_check_relations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.user_count IS DISTINCT FROM (SELECT count(*) FROM public.instrument_version_users WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.revision)
    OR EXISTS (SELECT 1 FROM public.instrument_version_users WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.revision AND position>=NEW.user_count)
    OR NEW.service_count IS DISTINCT FROM (SELECT count(*) FROM public.instrument_version_services WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.revision)
    OR EXISTS (SELECT 1 FROM public.instrument_version_services service WHERE service.organization_id=NEW.organization_id AND service.instrument_id=NEW.instrument_id AND service.revision=NEW.revision
      AND (service.position>=NEW.service_count OR service.role_count IS DISTINCT FROM (SELECT count(*) FROM public.instrument_version_service_roles role
        WHERE role.organization_id=service.organization_id AND role.instrument_id=service.instrument_id AND role.revision=service.revision AND role.service_id=service.id)
        OR EXISTS (SELECT 1 FROM public.instrument_version_service_roles role WHERE role.organization_id=service.organization_id AND role.instrument_id=service.instrument_id
          AND role.revision=service.revision AND role.service_id=service.id AND role.position>=service.role_count))) THEN
    RAISE EXCEPTION 'Instrument relationships require complete ordered snapshots' USING ERRCODE='23514',CONSTRAINT='instrument_relations_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER instrument_relations_complete AFTER INSERT ON instrument_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instruments_check_relations();
--> statement-breakpoint
CREATE FUNCTION instruments_guard_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Instrument file bytes are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR NEW.uploaded_by IS DISTINCT FROM public.instruments_require_writer()
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'Instrument files require their actual upload actor and transaction' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instrument_file_guard BEFORE INSERT OR UPDATE OR DELETE ON instrument_files FOR EACH ROW EXECUTE FUNCTION instruments_guard_file();
--> statement-breakpoint
CREATE FUNCTION instruments_upload_file(target_id uuid,file_name text,file_type text,file_content bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.instruments_require_writer(); org uuid:=public.organization_module_scope(); prior public.instrument_files; digest text;
BEGIN
  IF target_id IS NULL OR file_content IS NULL OR octet_length(file_content)>26214400 THEN
    RAISE EXCEPTION 'Invalid Instrument file' USING ERRCODE='23514',CONSTRAINT='instrument_file_values';
  END IF;
  digest:=encode(sha256(file_content),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('instrument-file:'||org::text||':'||target_id::text,0));
  SELECT original_name,media_type,byte_length,sha256,uploaded_by INTO prior.original_name,prior.media_type,prior.byte_length,prior.sha256,prior.uploaded_by
    FROM public.instrument_files WHERE organization_id=org AND id=target_id;
  IF FOUND THEN
    IF (prior.original_name,prior.media_type,prior.byte_length,prior.sha256,prior.uploaded_by)
      IS DISTINCT FROM (file_name,file_type,octet_length(file_content),digest,actor) THEN
      RAISE EXCEPTION 'Instrument file request reused' USING ERRCODE='23514',CONSTRAINT='instrument_file_request_reused';
    END IF;
    RETURN true;
  END IF;
  INSERT INTO public.instrument_files(organization_id,id,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,target_id,file_name,file_type,file_content,octet_length(file_content),digest,actor);
  RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_can_read_file(target_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.instruments_can_read(NULL) AND (public.app_has_permission('instruments.manage') OR EXISTS (
    SELECT 1 FROM public.instrument_versions version WHERE version.organization_id=public.organization_module_scope()
      AND version.purchase_file_id=target_id AND public.instruments_can_read(version.instrument_id)
  ));
$$;

--> statement-breakpoint
CREATE FUNCTION instruments_record_core(target_id uuid,previous_revision integer,operation text,fingerprint text,user_count integer,service_count integer,users_provided boolean,services_provided boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  INSERT INTO public.instrument_versions(organization_id,instrument_id,revision,request_id,request_fingerprint,previous_revision,operation,code,name,description,laboratory_id,make,model_name,serial_number,date_of_installation,calibration_agency,calibrated,cost_of_equipment,purchase_file_id,current_location,manufacturer_supplier,active,retired,status,current_status,laboratory_name,
    user_count,service_count,users_provided,services_provided,saved_by)
    SELECT head.organization_id,head.id,head.revision,head.save_request_id,fingerprint,nullif(previous_revision,0),operation,head.code,head.name,head.description,head.laboratory_id,head.make,head.model_name,head.serial_number,head.date_of_installation,head.calibration_agency,head.calibrated,head.cost_of_equipment,head.purchase_file_id,head.current_location,head.manufacturer_supplier,head.active,head.retired,head.status,head.current_status,laboratory.name,
      user_count,service_count,users_provided,services_provided,nullif(current_setting('app.user_id',true),'')::uuid
    FROM public.instruments head LEFT JOIN public.laboratories laboratory ON laboratory.organization_id=head.organization_id AND laboratory.id=head.laboratory_id
    WHERE head.organization_id=org AND head.id=target_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_check_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.instrument_versions;
BEGIN
  SELECT * INTO version FROM public.instrument_versions WHERE organization_id=NEW.organization_id AND instrument_id=NEW.id AND revision=NEW.revision;
  IF version.instrument_id IS NULL OR version.request_id IS DISTINCT FROM NEW.save_request_id OR version.saved_at IS DISTINCT FROM NEW.updated_at
    OR (NEW.code,NEW.name,NEW.description,NEW.laboratory_id,NEW.make,NEW.model_name,NEW.serial_number,NEW.date_of_installation,NEW.calibration_agency,NEW.calibrated,NEW.cost_of_equipment,NEW.purchase_file_id,NEW.current_location,NEW.manufacturer_supplier,NEW.active,NEW.retired,NEW.status,NEW.current_status) IS DISTINCT FROM (version.code,version.name,version.description,version.laboratory_id,version.make,version.model_name,version.serial_number,version.date_of_installation,version.calibration_agency,version.calibrated,version.cost_of_equipment,version.purchase_file_id,version.current_location,version.manufacturer_supplier,version.active,version.retired,version.status,version.current_status) THEN
    RAISE EXCEPTION 'Instrument head must match its recorded command' USING ERRCODE='23514',CONSTRAINT='instrument_head_history';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER instrument_head_history AFTER INSERT OR UPDATE ON instruments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instruments_check_head();

--> statement-breakpoint
CREATE FUNCTION instruments_copy_relations(target_id uuid,previous_revision integer,next_revision integer,copy_users boolean,copy_services boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF copy_users THEN
    INSERT INTO public.instrument_version_users(organization_id,instrument_id,revision,user_id,position,user_name,username)
      SELECT organization_id,instrument_id,next_revision,user_id,position,user_name,username FROM public.instrument_version_users
      WHERE organization_id=org AND instrument_id=target_id AND revision=previous_revision;
  END IF;
  IF copy_services THEN
    INSERT INTO public.instrument_version_services(organization_id,instrument_id,revision,id,position,service_definition_id,service_definition_revision,service_code,service_label,
      template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count)
      SELECT organization_id,instrument_id,next_revision,id,position,service_definition_id,service_definition_revision,service_code,service_label,
        template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count
      FROM public.instrument_version_services WHERE organization_id=org AND instrument_id=target_id AND revision=previous_revision;
    INSERT INTO public.instrument_version_service_roles(organization_id,instrument_id,revision,service_id,role_id,position,role_name)
      SELECT organization_id,instrument_id,next_revision,service_id,role_id,position,role_name FROM public.instrument_version_service_roles
      WHERE organization_id=org AND instrument_id=target_id AND revision=previous_revision;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_save_core(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text,
  p_code text,p_name text,p_description text,p_laboratory_id uuid,p_make text,p_model_name text,p_serial_number text,p_date_of_installation date,
  p_calibration_agency text,p_calibrated boolean,p_cost_of_equipment numeric,p_purchase_file_id uuid,p_current_location text,p_manufacturer_supplier text,p_active boolean,
  p_user_ids uuid[],p_services_provided boolean,p_service_ids uuid[],p_service_codes text[],p_template_ids uuid[],p_workflow_ids uuid[],
  p_reminder_before integer[],p_frequency integer[],p_last_performed date[],p_reminder_frequency integer[],p_next_reminder date[],p_service_active boolean[],
  p_role_service_ids uuid[],p_role_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.instruments; old_version public.instrument_versions;
  next_revision integer:=expected_revision+1; definition_revision integer; service_count integer:=cardinality(p_service_ids); user_count integer;
BEGIN
  prior:=public.instruments_prior_request(target_id,expected_revision,requested_id,fingerprint,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO head FROM public.instruments WHERE organization_id=org AND id=target_id FOR UPDATE;
  IF expected_revision>0 AND (head.id IS NULL OR head.retired) THEN
    RAISE EXCEPTION 'Instrument was not found' USING ERRCODE='P0002',CONSTRAINT='instrument_not_found';
  END IF;
  IF coalesce(head.revision,0)<>expected_revision THEN
    RAISE EXCEPTION 'Instrument changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='instrument_stale_revision';
  END IF;
  SELECT * INTO old_version FROM public.instrument_versions WHERE organization_id=org AND instrument_id=target_id AND revision=expected_revision;
  IF p_laboratory_id IS NULL OR p_date_of_installation IS NULL OR p_services_provided IS NULL
    OR (p_user_ids IS NULL AND expected_revision=0) OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids) NOT BETWEEN 1 AND 500 OR array_ndims(p_user_ids)<>1 OR array_position(p_user_ids,NULL) IS NOT NULL))
    OR service_count IS NULL OR service_count NOT BETWEEN 0 AND 100 OR (NOT p_services_provided AND service_count<>0)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[cardinality(p_service_codes),cardinality(p_template_ids),cardinality(p_workflow_ids),cardinality(p_reminder_before),cardinality(p_frequency),
      cardinality(p_last_performed),cardinality(p_reminder_frequency),cardinality(p_next_reminder),cardinality(p_service_active)]) size WHERE size IS DISTINCT FROM service_count)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[array_ndims(p_service_ids),array_ndims(p_service_codes),array_ndims(p_template_ids),array_ndims(p_workflow_ids),array_ndims(p_reminder_before),array_ndims(p_frequency),
      array_ndims(p_last_performed),array_ndims(p_reminder_frequency),array_ndims(p_next_reminder),array_ndims(p_service_active),array_ndims(p_role_ids),array_ndims(p_role_service_ids)]) dimensions WHERE dimensions>1)
    OR cardinality(p_role_ids) IS NULL OR cardinality(p_role_ids)>50000 OR cardinality(p_role_service_ids) IS DISTINCT FROM cardinality(p_role_ids)
    OR EXISTS (SELECT 1 FROM unnest(p_role_service_ids,p_role_ids) item(service_id,role_id) WHERE service_id IS NULL OR role_id IS NULL OR NOT service_id=ANY(p_service_ids))
    OR EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes,p_reminder_before,p_service_active) item(id,code,reminder,active) WHERE id IS NULL OR code IS NULL OR reminder IS NULL OR active IS NULL)
    OR (SELECT count(DISTINCT lower(code)) FROM unnest(p_service_codes) item(code))<>service_count THEN
    RAISE EXCEPTION 'Invalid Instrument fields or relationship arrays' USING ERRCODE='23514',CONSTRAINT='instrument_command_input';
  END IF;
  IF p_user_ids IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_user_ids) wanted(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=wanted.id)) THEN
    RAISE EXCEPTION 'Instrument users must belong to this organization' USING ERRCODE='23514',CONSTRAINT='instrument_reference';
  END IF;
  SELECT max(revision) INTO definition_revision FROM public.organization_instrument_service_versions WHERE organization_id=org;
  -- Template type changes lock their parent below; hold that parent until capture.
  PERFORM 1 FROM public.templates WHERE organization_id=org AND id=ANY(p_template_ids) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.workflows WHERE organization_id=org AND id=ANY(p_workflow_ids) ORDER BY id FOR SHARE;
  IF p_services_provided AND EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes,p_template_ids,p_workflow_ids) wanted(id,code,template_id,workflow_id)
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_instrument_service_entries definition WHERE definition.organization_id=org
      AND definition.revision=definition_revision AND definition.service_code=wanted.code AND definition.active)
    OR (wanted.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN LATERAL (
      SELECT kind FROM public.template_versions WHERE organization_id=org AND template_id=template.id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1
    ) version ON version.kind='equipment_service_log' WHERE template.organization_id=org AND template.id=wanted.template_id AND template.active))
    OR (wanted.workflow_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflows WHERE organization_id=org AND id=wanted.workflow_id AND active AND applies_to='instrument_service'))) THEN
    RAISE EXCEPTION 'Select configured active services and matching templates/workflows' USING ERRCODE='23514',CONSTRAINT='instrument_service_reference';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes) wanted(id,code)
    JOIN public.organization_instrument_service_entries definition ON definition.organization_id=org AND definition.revision=definition_revision AND definition.service_code=wanted.code
    JOIN public.instrument_version_services previous ON previous.organization_id=org AND previous.instrument_id=target_id AND previous.id=wanted.id
    WHERE previous.service_definition_id<>definition.id) THEN
    RAISE EXCEPTION 'A service configuration identity cannot be reused for another type' USING ERRCODE='23514',CONSTRAINT='instrument_service_identity';
  END IF;
  user_count:=CASE WHEN p_user_ids IS NULL THEN old_version.user_count ELSE cardinality(p_user_ids) END;
  IF NOT p_services_provided THEN service_count:=coalesce(old_version.service_count,0); END IF;
  -- Validate before numeric(18,2) rounds a small negative amount to zero.
  IF p_cost_of_equipment<0 OR p_cost_of_equipment IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) THEN
    RAISE EXCEPTION 'Instrument cost must be finite and nonnegative' USING ERRCODE='23514',CONSTRAINT='instrument_values';
  END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.instruments(organization_id,id,code,name,description,laboratory_id,make,model_name,serial_number,date_of_installation,calibration_agency,calibrated,
      cost_of_equipment,purchase_file_id,current_location,manufacturer_supplier,active,status,revision,save_request_id)
      VALUES(org,target_id,p_code,p_name,p_description,p_laboratory_id,p_make,p_model_name,p_serial_number,p_date_of_installation,p_calibration_agency,p_calibrated,
        p_cost_of_equipment,p_purchase_file_id,p_current_location,p_manufacturer_supplier,p_active,CASE WHEN p_active THEN 'available' ELSE 'retired' END,next_revision,requested_id);
  ELSE
    UPDATE public.instruments SET code=p_code,name=p_name,description=p_description,laboratory_id=p_laboratory_id,make=p_make,model_name=p_model_name,serial_number=p_serial_number,
      date_of_installation=p_date_of_installation,calibration_agency=p_calibration_agency,calibrated=p_calibrated,cost_of_equipment=p_cost_of_equipment,purchase_file_id=p_purchase_file_id,
      current_location=p_current_location,manufacturer_supplier=p_manufacturer_supplier,active=p_active,
      status=CASE WHEN NOT p_active THEN 'retired' WHEN status='retired' THEN 'available' ELSE status END,
      revision=next_revision,save_request_id=requested_id,updated_at=transaction_timestamp() WHERE organization_id=org AND id=target_id;
  END IF;
  PERFORM public.instruments_record_core(target_id,expected_revision,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END,fingerprint,user_count,service_count,p_user_ids IS NOT NULL,p_services_provided);
  PERFORM public.instruments_copy_relations(target_id,expected_revision,next_revision,p_user_ids IS NULL,NOT p_services_provided);
  IF p_user_ids IS NOT NULL THEN
    INSERT INTO public.instrument_version_users(organization_id,instrument_id,revision,user_id,position,user_name,username)
      SELECT org,target_id,next_revision,wanted.id,wanted.position-1,person.display_name,person.username FROM unnest(p_user_ids) WITH ORDINALITY wanted(id,position)
      JOIN public.users person ON person.id=wanted.id;
  END IF;
  IF p_services_provided THEN
    INSERT INTO public.instrument_version_services(organization_id,instrument_id,revision,id,position,service_definition_id,service_definition_revision,service_code,service_label,
      template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count)
      SELECT org,target_id,next_revision,wanted.id,wanted.position-1,definition.id,definition_revision,definition.service_code,definition.display_label,
        wanted.template_id,wanted.workflow_id,template.name,workflow.name,wanted.reminder,wanted.frequency,wanted.last_performed,wanted.reminder_frequency,wanted.next_reminder,wanted.active,
        (SELECT count(*) FROM unnest(p_role_service_ids) role(service_id) WHERE role.service_id=wanted.id)
      FROM unnest(p_service_ids,p_service_codes,p_template_ids,p_workflow_ids,p_reminder_before,p_frequency,p_last_performed,p_reminder_frequency,p_next_reminder,p_service_active)
        WITH ORDINALITY wanted(id,code,template_id,workflow_id,reminder,frequency,last_performed,reminder_frequency,next_reminder,active,position)
      JOIN public.organization_instrument_service_entries definition ON definition.organization_id=org AND definition.revision=definition_revision AND definition.service_code=wanted.code
      LEFT JOIN public.workflows workflow ON workflow.organization_id=org AND workflow.id=wanted.workflow_id
      LEFT JOIN LATERAL (SELECT name FROM public.template_versions WHERE organization_id=org AND template_id=wanted.template_id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1) template ON true;
    INSERT INTO public.instrument_version_service_roles(organization_id,instrument_id,revision,service_id,role_id,position,role_name)
      SELECT org,target_id,next_revision,wanted.service_id,wanted.role_id,row_number() OVER(PARTITION BY wanted.service_id ORDER BY wanted.position)-1,role.name
      FROM unnest(p_role_service_ids,p_role_ids) WITH ORDINALITY wanted(service_id,role_id,position)
      JOIN public.roles role ON role.organization_id=org AND role.id=wanted.role_id;
  END IF;
  RETURN next_revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_retire(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.instruments; version public.instrument_versions;
BEGIN
  prior:=public.instruments_prior_request(target_id,expected_revision,requested_id,fingerprint,'retire'); IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO head FROM public.instruments WHERE organization_id=org AND id=target_id FOR UPDATE;
  IF head.id IS NULL OR head.retired THEN RAISE EXCEPTION 'Instrument was not found' USING ERRCODE='P0002',CONSTRAINT='instrument_not_found'; END IF;
  IF expected_revision<1 OR head.revision<>expected_revision THEN
    RAISE EXCEPTION 'Instrument changed; reload before deleting' USING ERRCODE='23514',CONSTRAINT='instrument_stale_revision';
  END IF;
  SELECT * INTO version FROM public.instrument_versions WHERE organization_id=org AND instrument_id=target_id AND revision=expected_revision;
  UPDATE public.instruments SET active=false,retired=true,status='retired',revision=revision+1,save_request_id=requested_id,updated_at=transaction_timestamp()
    WHERE organization_id=org AND id=target_id;
  PERFORM public.instruments_record_core(target_id,expected_revision,'retire',fingerprint,version.user_count,version.service_count,false,false);
  PERFORM public.instruments_copy_relations(target_id,expected_revision,expected_revision+1,true,true);
  RETURN expected_revision+1;
END $$;

--> statement-breakpoint
CREATE FUNCTION instruments_guard_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retire Instruments without removing history' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at) THEN
    RAISE EXCEPTION 'Instrument identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instrument_head_guard BEFORE UPDATE OR DELETE ON instruments FOR EACH ROW EXECUTE FUNCTION instruments_guard_head();
--> statement-breakpoint
CREATE FUNCTION instruments_guard_workflow_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF (NOT NEW.active OR NEW.applies_to<>'instrument_service') AND EXISTS (
    SELECT 1 FROM public.instruments instrument JOIN public.instrument_version_services service
      ON service.organization_id=instrument.organization_id AND service.instrument_id=instrument.id AND service.revision=instrument.revision
    WHERE instrument.organization_id=NEW.organization_id AND NOT instrument.retired AND service.workflow_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'Workflow is configured for an Instrument' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instrument_workflow_reference BEFORE UPDATE OF active,applies_to ON workflows FOR EACH ROW EXECUTE FUNCTION instruments_guard_workflow_reference();
--> statement-breakpoint
CREATE FUNCTION instruments_guard_template_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target_id uuid; invalid boolean;
BEGIN
  IF TG_TABLE_NAME='templates' THEN target_id:=NEW.id; invalid:=NOT NEW.active;
  ELSE
    target_id:=NEW.template_id; invalid:=NEW.kind<>'equipment_service_log';
    -- Taking the parent lock also protects a concurrent first configuration.
    PERFORM 1 FROM public.templates WHERE organization_id=NEW.organization_id AND id=target_id FOR UPDATE;
  END IF;
  IF invalid AND EXISTS (
    SELECT 1 FROM public.instruments instrument JOIN public.instrument_version_services service
      ON service.organization_id=instrument.organization_id AND service.instrument_id=instrument.id AND service.revision=instrument.revision
    WHERE instrument.organization_id=NEW.organization_id AND NOT instrument.retired AND service.template_id=target_id
  ) THEN
    RAISE EXCEPTION 'Template is configured for an Instrument' USING ERRCODE='23514',CONSTRAINT='instrument_template_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instrument_template_reference BEFORE UPDATE OF active ON templates FOR EACH ROW EXECUTE FUNCTION instruments_guard_template_reference();
CREATE TRIGGER instrument_template_kind_reference BEFORE INSERT OR UPDATE OF kind ON template_versions FOR EACH ROW EXECUTE FUNCTION instruments_guard_template_reference();
--> statement-breakpoint
DO $$ DECLARE relation text; id_column text; BEGIN
  FOREACH relation IN ARRAY ARRAY['instruments','instrument_versions','instrument_version_users','instrument_version_services','instrument_version_service_roles'] LOOP
    id_column:=CASE WHEN relation='instruments' THEN 'id' ELSE 'instrument_id' END;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY instrument_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=(SELECT organization_module_scope()) AND instruments_can_read(%I))',relation,id_column);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    IF relation<>'instruments' THEN
      EXECUTE format('CREATE TRIGGER instrument_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION instruments_guard_history()',relation);
    END IF;
  END LOOP;
END $$;
ALTER TABLE instrument_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_files FORCE ROW LEVEL SECURITY;
CREATE POLICY instrument_file_read ON instrument_files FOR SELECT TO sampleify_app
  USING(organization_id=(SELECT organization_module_scope()) AND instruments_can_read_file(id));
REVOKE ALL ON instrument_files FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON instrument_files TO sampleify_app;
--> statement-breakpoint
CREATE VIEW instrument_user_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT membership.organization_id,person.id,person.display_name AS name,person.username,person.active AND membership.active AS active
    FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
    WHERE membership.organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL));
CREATE VIEW instrument_role_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,name,active FROM public.roles
    WHERE organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL));
CREATE VIEW instrument_laboratory_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,code,name,active FROM public.laboratories
    WHERE organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL));
CREATE VIEW instrument_service_type_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT entry.organization_id,entry.id,entry.revision,entry.position,entry.service_code,entry.display_label,entry.active
    FROM public.organization_instrument_service_entries entry WHERE entry.organization_id=(SELECT public.organization_module_scope())
      AND (SELECT public.instruments_can_read(NULL)) AND entry.revision=(SELECT max(revision) FROM public.organization_instrument_service_versions WHERE organization_id=entry.organization_id);
CREATE VIEW instrument_template_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT template.organization_id,template.id,template.code,version.name,version.kind,template.active
    FROM public.templates template JOIN LATERAL (SELECT name,kind FROM public.template_versions
      WHERE organization_id=template.organization_id AND template_id=template.id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1) version ON true
    WHERE template.organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL)) AND version.kind='equipment_service_log';
CREATE VIEW instrument_workflow_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,name,active FROM public.workflows WHERE organization_id=(SELECT public.organization_module_scope())
    AND (SELECT public.instruments_can_read(NULL)) AND applies_to='instrument_service';
REVOKE ALL ON instrument_user_catalog,instrument_role_catalog,instrument_laboratory_catalog,instrument_service_type_catalog,instrument_template_catalog,instrument_workflow_catalog
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON instrument_user_catalog,instrument_role_catalog,instrument_laboratory_catalog,instrument_service_type_catalog,instrument_template_catalog,instrument_workflow_catalog TO sampleify_app;
--> statement-breakpoint
DO $$ DECLARE routine record; BEGIN
  FOR routine IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'instruments_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,sampleify_app,sampleify_report_worker',routine.signature);
    IF routine.proname IN ('instruments_can_read','instruments_require_writer','instruments_prior_request','instruments_save_core','instruments_retire','instruments_upload_file','instruments_can_read_file') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sampleify_app',routine.signature);
    END IF;
  END LOOP;
END $$;

