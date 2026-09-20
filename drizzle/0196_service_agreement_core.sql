CREATE TABLE "service_agreement_files" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_agreement_file_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "service_agreement_file_values" CHECK (length("service_agreement_files"."original_name") between 1 and 500 and "service_agreement_files"."original_name"=trim("service_agreement_files"."original_name")
    and "service_agreement_files"."original_name" !~ '[[:cntrl:]]' and position('/' in "service_agreement_files"."original_name")=0 and position(chr(92) in "service_agreement_files"."original_name")=0
    and "service_agreement_files"."media_type" in ('application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    and "service_agreement_files"."byte_length" between 1 and 26214400 and "service_agreement_files"."byte_length"=octet_length("service_agreement_files"."content") and "service_agreement_files"."sha256"=encode(sha256("service_agreement_files"."content"),'hex'))
);


--> statement-breakpoint
CREATE TABLE "service_agreement_version_instruments" (
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"instrument_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"instrument_revision" integer NOT NULL,
	"instrument_name" text NOT NULL,
	"instrument_code" text NOT NULL,
	CONSTRAINT "service_agreement_instrument_pk" PRIMARY KEY("organization_id","agreement_id","revision","instrument_id"),
	CONSTRAINT "service_agreement_instrument_position" UNIQUE("organization_id","agreement_id","revision","position"),
	CONSTRAINT "service_agreement_instrument_values" CHECK ("service_agreement_version_instruments"."position" between 0 and 499 and "service_agreement_version_instruments"."instrument_revision">0)
);


--> statement-breakpoint
CREATE TABLE "service_agreement_version_services" (
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"service_code" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "service_agreement_service_pk" PRIMARY KEY("organization_id","agreement_id","revision","service_code"),
	CONSTRAINT "service_agreement_service_position" UNIQUE("organization_id","agreement_id","revision","position"),
	CONSTRAINT "service_agreement_service_values" CHECK ("service_agreement_version_services"."position" between 0 and 2 and "service_agreement_version_services"."service_code" in ('calibration','preventivemaintenance','breakdown'))
);


--> statement-breakpoint
CREATE TABLE "service_agreement_versions" (
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"vendor_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"no_of_services" integer DEFAULT 0 NOT NULL,
	"cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"in_effect" boolean DEFAULT false NOT NULL,
	"attachment_file_id" uuid,
	"retired" boolean DEFAULT false NOT NULL,
	"vendor_revision" integer NOT NULL,
	"vendor_name" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"instrument_count" integer NOT NULL,
	"service_count" integer NOT NULL,
	"instruments_provided" boolean NOT NULL,
	"services_provided" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "service_agreement_version_pk" PRIMARY KEY("organization_id","agreement_id","revision"),
	CONSTRAINT "service_agreement_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "service_agreement_version_values" CHECK ("service_agreement_versions"."start_date" between date '0001-01-01' and date '9999-12-31'
  and "service_agreement_versions"."end_date" between date '0001-01-01' and date '9999-12-31' and "service_agreement_versions"."start_date"<="service_agreement_versions"."end_date"
  and "service_agreement_versions"."no_of_services">=0 and "service_agreement_versions"."cost">=0 and "service_agreement_versions"."cost" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
  and ("service_agreement_versions"."notes" is null or length("service_agreement_versions"."notes")<=10000) and (not "service_agreement_versions"."retired" or not "service_agreement_versions"."in_effect")),
	CONSTRAINT "service_agreement_version_revision" CHECK (("service_agreement_versions"."operation"='create' and "service_agreement_versions"."previous_revision" is null and "service_agreement_versions"."revision"=1)
    or ("service_agreement_versions"."operation" in ('update','retire') and "service_agreement_versions"."previous_revision">0 and "service_agreement_versions"."previous_revision" is not null and "service_agreement_versions"."revision"="service_agreement_versions"."previous_revision"+1)),
	CONSTRAINT "service_agreement_version_command" CHECK ("service_agreement_versions"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "service_agreement_versions"."vendor_revision">0
    and "service_agreement_versions"."instrument_count" between 1 and 500 and "service_agreement_versions"."service_count" between 0 and 3 and ("service_agreement_versions"."retired"=("service_agreement_versions"."operation"='retire'))
    and ("service_agreement_versions"."operation"<>'retire' or (not "service_agreement_versions"."instruments_provided" and not "service_agreement_versions"."services_provided")))
);


--> statement-breakpoint
CREATE TABLE "service_agreements" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"no_of_services" integer DEFAULT 0 NOT NULL,
	"cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"in_effect" boolean DEFAULT false NOT NULL,
	"attachment_file_id" uuid,
	"retired" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"save_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_agreement_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "service_agreement_values" CHECK ("service_agreements"."start_date" between date '0001-01-01' and date '9999-12-31'
  and "service_agreements"."end_date" between date '0001-01-01' and date '9999-12-31' and "service_agreements"."start_date"<="service_agreements"."end_date"
  and "service_agreements"."no_of_services">=0 and "service_agreements"."cost">=0 and "service_agreements"."cost" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
  and ("service_agreements"."notes" is null or length("service_agreements"."notes")<=10000) and (not "service_agreements"."retired" or not "service_agreements"."in_effect")),
	CONSTRAINT "service_agreement_revision" CHECK ("service_agreements"."revision">0)
);


--> statement-breakpoint
ALTER TABLE "service_agreement_files" ADD CONSTRAINT "service_agreement_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_files" ADD CONSTRAINT "service_agreement_file_actor_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_version_instruments" ADD CONSTRAINT "service_agreement_instrument_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_version_instruments" ADD CONSTRAINT "service_agreement_instrument_parent_fk" FOREIGN KEY ("organization_id","agreement_id","revision") REFERENCES "public"."service_agreement_versions"("organization_id","agreement_id","revision") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_version_instruments" ADD CONSTRAINT "service_agreement_instrument_reference_fk" FOREIGN KEY ("organization_id","instrument_id") REFERENCES "public"."instruments"("organization_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_version_services" ADD CONSTRAINT "service_agreement_service_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_version_services" ADD CONSTRAINT "service_agreement_service_parent_fk" FOREIGN KEY ("organization_id","agreement_id","revision") REFERENCES "public"."service_agreement_versions"("organization_id","agreement_id","revision") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_versions" ADD CONSTRAINT "service_agreement_version_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_versions" ADD CONSTRAINT "service_agreement_version_parent_fk" FOREIGN KEY ("organization_id","agreement_id") REFERENCES "public"."service_agreements"("organization_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_versions" ADD CONSTRAINT "service_agreement_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_versions" ADD CONSTRAINT "service_agreement_version_vendor_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreement_versions" ADD CONSTRAINT "service_agreement_version_file_fk" FOREIGN KEY ("organization_id","attachment_file_id") REFERENCES "public"."service_agreement_files"("organization_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreement_vendor_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreement_file_fk" FOREIGN KEY ("organization_id","attachment_file_id") REFERENCES "public"."service_agreement_files"("organization_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
CREATE INDEX "service_agreement_instrument_use" ON "service_agreement_version_instruments" USING btree ("organization_id","instrument_id","agreement_id","revision");

--> statement-breakpoint
CREATE INDEX "service_agreement_listing" ON "service_agreements" USING btree ("organization_id","created_at","id") WHERE not "service_agreements"."retired";

--> statement-breakpoint
CREATE INDEX "service_agreement_vendor_use" ON "service_agreements" USING btree ("organization_id","vendor_id") WHERE not "service_agreements"."retired";

--> statement-breakpoint
CREATE FUNCTION service_agreements_can_read() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.organization_module_scope() IS NOT NULL AND public.organization_has_module_access('service_agreements')
    AND (public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'));
$$;
CREATE FUNCTION service_agreements_require_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_lock_field_writer();
  RETURN public.organization_require_module_access('service_agreements');
END $$;
--> statement-breakpoint
CREATE FUNCTION service_agreements_prior_request(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text,requested_operation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.service_agreements_require_writer(); org uuid:=public.organization_module_scope(); prior public.service_agreement_versions;
BEGIN
  IF target_id IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR requested_id IS NULL
    OR fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' OR requested_operation IS NULL OR requested_operation NOT IN ('create','update','retire')
    OR (requested_operation='create') IS DISTINCT FROM (expected_revision=0) THEN
    RAISE EXCEPTION 'Invalid Service Agreement command' USING ERRCODE='23514',CONSTRAINT='service_agreement_command_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('service-agreement-save:'||org::text||':'||requested_id::text,0));
  SELECT * INTO prior FROM public.service_agreement_versions WHERE organization_id=org AND request_id=requested_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (prior.agreement_id,coalesce(prior.previous_revision,0),prior.operation,prior.request_fingerprint,prior.saved_by)
    IS DISTINCT FROM (target_id,expected_revision,requested_operation,fingerprint,actor) THEN
    RAISE EXCEPTION 'Service Agreement request was already used for another change' USING ERRCODE='23514',CONSTRAINT='service_agreement_request_reused';
  END IF;
  RETURN prior.revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION service_agreements_guard_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.service_agreement_versions; head public.service_agreements;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Service Agreement history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO head FROM public.service_agreements WHERE organization_id=NEW.organization_id AND id=NEW.agreement_id;
  IF TG_TABLE_NAME='service_agreement_versions' THEN version:=NEW;
  ELSE SELECT * INTO version FROM public.service_agreement_versions WHERE organization_id=NEW.organization_id AND agreement_id=NEW.agreement_id AND revision=NEW.revision; END IF;
  IF version.agreement_id IS NULL OR head.id IS NULL OR version.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR version.saved_at IS DISTINCT FROM transaction_timestamp() OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR head.revision IS DISTINCT FROM NEW.revision
    OR head.save_request_id IS DISTINCT FROM version.request_id THEN
    RAISE EXCEPTION 'Service Agreement history requires the actual saved command' USING ERRCODE='23514',CONSTRAINT='service_agreement_history_transaction';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION service_agreements_check_relations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.instrument_count IS DISTINCT FROM (SELECT count(*) FROM public.service_agreement_version_instruments WHERE organization_id=NEW.organization_id AND agreement_id=NEW.agreement_id AND revision=NEW.revision)
    OR EXISTS (SELECT 1 FROM public.service_agreement_version_instruments WHERE organization_id=NEW.organization_id AND agreement_id=NEW.agreement_id AND revision=NEW.revision AND position>=NEW.instrument_count)
    OR NEW.service_count IS DISTINCT FROM (SELECT count(*) FROM public.service_agreement_version_services WHERE organization_id=NEW.organization_id AND agreement_id=NEW.agreement_id AND revision=NEW.revision)
    OR EXISTS (SELECT 1 FROM public.service_agreement_version_services WHERE organization_id=NEW.organization_id AND agreement_id=NEW.agreement_id AND revision=NEW.revision AND position>=NEW.service_count) THEN
    RAISE EXCEPTION 'Service Agreement relationships require complete ordered snapshots' USING ERRCODE='23514',CONSTRAINT='service_agreement_relations_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_agreement_relations_complete AFTER INSERT ON service_agreement_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_agreements_check_relations();
CREATE FUNCTION service_agreements_check_head_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.service_agreement_versions;
BEGIN
  SELECT * INTO version FROM public.service_agreement_versions WHERE organization_id=NEW.organization_id AND agreement_id=NEW.id AND revision=NEW.revision;
  IF version.agreement_id IS NULL OR
    (NEW.vendor_id,NEW.start_date,NEW.end_date,NEW.no_of_services,NEW.cost,NEW.notes,NEW.in_effect,NEW.attachment_file_id,NEW.retired,NEW.save_request_id,NEW.updated_at)
    IS DISTINCT FROM
    (version.vendor_id,version.start_date,version.end_date,version.no_of_services,version.cost,version.notes,version.in_effect,version.attachment_file_id,version.retired,version.request_id,version.saved_at) THEN
    RAISE EXCEPTION 'Service Agreement head requires matching immutable history' USING ERRCODE='23514',CONSTRAINT='service_agreement_head_history';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_agreement_head_history AFTER INSERT OR UPDATE ON service_agreements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_agreements_check_head_history();
CREATE FUNCTION service_agreements_guard_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retire Service Agreements without removing history' USING ERRCODE='55000'; END IF;
  IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at) THEN
    RAISE EXCEPTION 'Service Agreement identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_agreement_head_guard BEFORE UPDATE OR DELETE ON service_agreements FOR EACH ROW EXECUTE FUNCTION service_agreements_guard_head();
--> statement-breakpoint
CREATE FUNCTION service_agreements_record(target_id uuid,previous_revision integer,operation text,fingerprint text,
  vendor_revision integer,vendor_name text,instrument_count integer,service_count integer,instruments_provided boolean,services_provided boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  INSERT INTO public.service_agreement_versions(organization_id,agreement_id,revision,vendor_id,start_date,end_date,no_of_services,cost,notes,in_effect,attachment_file_id,retired,
    vendor_revision,vendor_name,request_id,request_fingerprint,previous_revision,operation,instrument_count,service_count,instruments_provided,services_provided,saved_by)
  SELECT head.organization_id,head.id,head.revision,head.vendor_id,head.start_date,head.end_date,head.no_of_services,head.cost,head.notes,head.in_effect,head.attachment_file_id,head.retired,
    vendor_revision,vendor_name,head.save_request_id,fingerprint,previous_revision,operation,instrument_count,service_count,instruments_provided,services_provided,
    nullif(current_setting('app.user_id',true),'')::uuid
  FROM public.service_agreements head WHERE head.organization_id=public.organization_module_scope() AND head.id=target_id;
$$;
CREATE FUNCTION service_agreements_copy_relations(target_id uuid,previous_revision integer,next_revision integer,copy_instruments boolean,copy_services boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF copy_instruments THEN
    INSERT INTO public.service_agreement_version_instruments(organization_id,agreement_id,revision,instrument_id,position,instrument_revision,instrument_name,instrument_code)
      SELECT organization_id,agreement_id,next_revision,instrument_id,position,instrument_revision,instrument_name,instrument_code
      FROM public.service_agreement_version_instruments WHERE organization_id=org AND agreement_id=target_id AND revision=previous_revision;
  END IF;
  IF copy_services THEN
    INSERT INTO public.service_agreement_version_services(organization_id,agreement_id,revision,service_code,position)
      SELECT organization_id,agreement_id,next_revision,service_code,position FROM public.service_agreement_version_services
      WHERE organization_id=org AND agreement_id=target_id AND revision=previous_revision;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION service_agreements_save(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text,
  p_vendor_id uuid,p_start_date date,p_end_date date,p_no_of_services integer,p_cost numeric,p_notes text,p_in_effect boolean,p_file_id uuid,
  p_instruments uuid[],p_services text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.service_agreements; version public.service_agreement_versions;
  vendor public.vendors; instrument_count integer; service_count integer; next_revision integer:=expected_revision+1;
BEGIN
  prior:=public.service_agreements_prior_request(target_id,expected_revision,requested_id,fingerprint,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO head FROM public.service_agreements WHERE organization_id=org AND id=target_id FOR UPDATE;
  IF expected_revision>0 AND (head.id IS NULL OR head.retired) THEN
    RAISE EXCEPTION 'Service Agreement was not found' USING ERRCODE='P0002',CONSTRAINT='service_agreement_not_found';
  END IF;
  IF coalesce(head.revision,0)<>expected_revision THEN
    RAISE EXCEPTION 'Service Agreement changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='service_agreement_stale_revision';
  END IF;
  IF p_vendor_id IS NULL OR p_start_date IS NULL OR p_end_date IS NULL OR p_no_of_services IS NULL OR p_no_of_services<0
    OR p_cost IS NULL OR p_cost<0 OR p_cost IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) OR p_in_effect IS NULL
    OR (p_instruments IS NULL AND expected_revision=0)
    OR (p_instruments IS NOT NULL AND (cardinality(p_instruments) NOT BETWEEN 1 AND 500 OR array_ndims(p_instruments) IS DISTINCT FROM 1 OR array_position(p_instruments,NULL) IS NOT NULL
      OR cardinality(p_instruments)<>(SELECT count(DISTINCT id) FROM unnest(p_instruments) selection(id))))
    OR (p_services IS NOT NULL AND (cardinality(p_services)>3 OR (cardinality(p_services)>0 AND array_ndims(p_services) IS DISTINCT FROM 1)
      OR EXISTS (SELECT 1 FROM unnest(p_services) selection(code) WHERE code IS NULL OR code NOT IN ('calibration','preventivemaintenance','breakdown'))
      OR cardinality(p_services)<>(SELECT count(DISTINCT code) FROM unnest(p_services) selection(code)))) THEN
    RAISE EXCEPTION 'Check Service Agreement details and selections' USING ERRCODE='23514',CONSTRAINT='service_agreement_command_input';
  END IF;
  SELECT * INTO vendor FROM public.vendors WHERE organization_id=org AND id=p_vendor_id FOR SHARE;
  IF vendor.id IS NULL OR vendor.retired THEN
    RAISE EXCEPTION 'Select an available Vendor in this organization' USING ERRCODE='23514',CONSTRAINT='service_agreement_reference';
  END IF;
  IF p_instruments IS NOT NULL THEN
    PERFORM 1 FROM public.instruments WHERE organization_id=org AND id=ANY(p_instruments) ORDER BY id FOR SHARE;
    IF EXISTS (SELECT 1 FROM unnest(p_instruments) selected(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.instruments instrument WHERE instrument.organization_id=org AND instrument.id=selected.id AND NOT instrument.retired)) THEN
      RAISE EXCEPTION 'Select available Instruments in this organization' USING ERRCODE='23514',CONSTRAINT='service_agreement_reference';
    END IF;
  END IF;
  IF p_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_agreement_files WHERE organization_id=org AND id=p_file_id) THEN
    RAISE EXCEPTION 'Select an Agreement attachment in this organization' USING ERRCODE='23514',CONSTRAINT='service_agreement_reference';
  END IF;
  IF expected_revision>0 THEN SELECT * INTO version FROM public.service_agreement_versions WHERE organization_id=org AND agreement_id=target_id AND revision=expected_revision; END IF;
  instrument_count:=coalesce(cardinality(p_instruments),version.instrument_count);
  service_count:=coalesce(cardinality(p_services),version.service_count,0);
  IF expected_revision=0 THEN
    INSERT INTO public.service_agreements(organization_id,id,vendor_id,start_date,end_date,no_of_services,cost,notes,in_effect,attachment_file_id,save_request_id)
      VALUES(org,target_id,p_vendor_id,p_start_date,p_end_date,p_no_of_services,p_cost,p_notes,p_in_effect,p_file_id,requested_id);
  ELSE
    UPDATE public.service_agreements SET vendor_id=p_vendor_id,start_date=p_start_date,end_date=p_end_date,no_of_services=p_no_of_services,cost=p_cost,notes=p_notes,
      in_effect=p_in_effect,attachment_file_id=p_file_id,revision=next_revision,save_request_id=requested_id,updated_at=transaction_timestamp()
      WHERE organization_id=org AND id=target_id;
  END IF;
  PERFORM public.service_agreements_record(target_id,CASE WHEN expected_revision=0 THEN NULL ELSE expected_revision END,
    CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END,fingerprint,vendor.revision,vendor.name,instrument_count,service_count,p_instruments IS NOT NULL,p_services IS NOT NULL);
  IF expected_revision>0 THEN PERFORM public.service_agreements_copy_relations(target_id,expected_revision,next_revision,p_instruments IS NULL,p_services IS NULL); END IF;
  IF p_instruments IS NOT NULL THEN
    INSERT INTO public.service_agreement_version_instruments(organization_id,agreement_id,revision,instrument_id,position,instrument_revision,instrument_name,instrument_code)
      SELECT org,target_id,next_revision,instrument.id,selection.position-1,instrument.revision,instrument.name,instrument.code
      FROM unnest(p_instruments) WITH ORDINALITY selection(id,position) JOIN public.instruments instrument ON instrument.organization_id=org AND instrument.id=selection.id;
  END IF;
  IF p_services IS NOT NULL THEN
    INSERT INTO public.service_agreement_version_services(organization_id,agreement_id,revision,service_code,position)
      SELECT org,target_id,next_revision,code,position-1 FROM unnest(p_services) WITH ORDINALITY selection(code,position);
  END IF;
  RETURN next_revision;
END $$;
CREATE FUNCTION service_agreements_retire(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.service_agreements; version public.service_agreement_versions;
BEGIN
  prior:=public.service_agreements_prior_request(target_id,expected_revision,requested_id,fingerprint,'retire'); IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO head FROM public.service_agreements WHERE organization_id=org AND id=target_id FOR UPDATE;
  IF head.id IS NULL OR head.retired THEN RAISE EXCEPTION 'Service Agreement was not found' USING ERRCODE='P0002',CONSTRAINT='service_agreement_not_found'; END IF;
  IF head.revision<>expected_revision THEN
    RAISE EXCEPTION 'Service Agreement changed; reload before deleting' USING ERRCODE='23514',CONSTRAINT='service_agreement_stale_revision';
  END IF;
  SELECT * INTO version FROM public.service_agreement_versions WHERE organization_id=org AND agreement_id=target_id AND revision=expected_revision;
  UPDATE public.service_agreements SET retired=true,in_effect=false,revision=revision+1,save_request_id=requested_id,updated_at=transaction_timestamp()
    WHERE organization_id=org AND id=target_id;
  PERFORM public.service_agreements_record(target_id,expected_revision,'retire',fingerprint,version.vendor_revision,version.vendor_name,version.instrument_count,version.service_count,false,false);
  PERFORM public.service_agreements_copy_relations(target_id,expected_revision,expected_revision+1,true,true);
  RETURN expected_revision+1;
END $$;
--> statement-breakpoint
CREATE FUNCTION service_agreements_guard_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Service Agreement file bytes are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR NEW.uploaded_by IS DISTINCT FROM public.service_agreements_require_writer()
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'Service Agreement files require their actual upload actor and transaction' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_agreement_file_guard BEFORE INSERT OR UPDATE OR DELETE ON service_agreement_files FOR EACH ROW EXECUTE FUNCTION service_agreements_guard_file();
CREATE FUNCTION service_agreements_upload_file(target_id uuid,file_name text,file_type text,file_content bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.service_agreements_require_writer(); org uuid:=public.organization_module_scope(); prior public.service_agreement_files; digest text;
BEGIN
  IF target_id IS NULL OR file_content IS NULL OR octet_length(file_content) NOT BETWEEN 1 AND 26214400 THEN
    RAISE EXCEPTION 'Invalid Service Agreement file' USING ERRCODE='23514',CONSTRAINT='service_agreement_file_values';
  END IF;
  digest:=encode(sha256(file_content),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('service-agreement-file:'||org::text||':'||target_id::text,0));
  SELECT original_name,media_type,byte_length,sha256,uploaded_by INTO prior.original_name,prior.media_type,prior.byte_length,prior.sha256,prior.uploaded_by
    FROM public.service_agreement_files WHERE organization_id=org AND id=target_id;
  IF FOUND THEN
    IF (prior.original_name,prior.media_type,prior.byte_length,prior.sha256,prior.uploaded_by)
      IS DISTINCT FROM (file_name,file_type,octet_length(file_content),digest,actor) THEN
      RAISE EXCEPTION 'Service Agreement file request reused' USING ERRCODE='23514',CONSTRAINT='service_agreement_file_request_reused';
    END IF;
    RETURN true;
  END IF;
  INSERT INTO public.service_agreement_files(organization_id,id,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,target_id,file_name,file_type,file_content,octet_length(file_content),digest,actor);
  RETURN false;
END $$;
CREATE FUNCTION service_agreements_can_read_file(target_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.service_agreements_can_read() AND (public.app_has_permission('masters.manage') OR EXISTS (
    SELECT 1 FROM public.service_agreement_versions WHERE organization_id=public.organization_module_scope() AND attachment_file_id=target_id
  ));
$$;
--> statement-breakpoint
CREATE FUNCTION service_agreements_guard_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='vendors' THEN
    IF EXISTS (SELECT 1 FROM public.service_agreements WHERE organization_id=NEW.organization_id AND vendor_id=NEW.id AND NOT retired) THEN
      RAISE EXCEPTION 'Vendor is used by a Service Agreement' USING ERRCODE='23514',CONSTRAINT='vendor_in_use';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.service_agreements agreement JOIN public.service_agreement_version_instruments selection
      ON selection.organization_id=agreement.organization_id AND selection.agreement_id=agreement.id AND selection.revision=agreement.revision
      WHERE agreement.organization_id=NEW.organization_id AND NOT agreement.retired AND selection.instrument_id=NEW.id) THEN
      RAISE EXCEPTION 'Instrument is used by a Service Agreement' USING ERRCODE='23514',CONSTRAINT='instrument_in_use';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_agreement_vendor_reference BEFORE UPDATE OF retired ON vendors
  FOR EACH ROW WHEN (NEW.retired AND NOT OLD.retired) EXECUTE FUNCTION service_agreements_guard_reference();
CREATE TRIGGER service_agreement_instrument_reference BEFORE UPDATE OF retired ON instruments
  FOR EACH ROW WHEN (NEW.retired AND NOT OLD.retired) EXECUTE FUNCTION service_agreements_guard_reference();
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['service_agreements','service_agreement_versions','service_agreement_version_instruments','service_agreement_version_services'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY service_agreement_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=(SELECT organization_module_scope()) AND (SELECT service_agreements_can_read()))',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    IF relation<>'service_agreements' THEN
      EXECUTE format('CREATE TRIGGER service_agreement_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION service_agreements_guard_history()',relation);
    END IF;
  END LOOP;
END $$;
ALTER TABLE service_agreement_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement_files FORCE ROW LEVEL SECURITY;
CREATE POLICY service_agreement_file_read ON service_agreement_files FOR SELECT TO sampleify_app
  USING(organization_id=(SELECT organization_module_scope()) AND service_agreements_can_read_file(id));
REVOKE ALL ON service_agreement_files FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON service_agreement_files TO sampleify_app;
CREATE VIEW service_agreement_vendor_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,revision,code,name,active FROM public.vendors WHERE organization_id=(SELECT public.organization_module_scope())
    AND (SELECT public.service_agreements_can_read()) AND NOT retired;
CREATE VIEW service_agreement_instrument_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,revision,code,name,active FROM public.instruments WHERE organization_id=(SELECT public.organization_module_scope())
    AND (SELECT public.service_agreements_can_read()) AND NOT retired;
REVOKE ALL ON service_agreement_vendor_catalog,service_agreement_instrument_catalog FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON service_agreement_vendor_catalog,service_agreement_instrument_catalog TO sampleify_app;
DO $$ DECLARE routine record; BEGIN
  FOR routine IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'service_agreements_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,sampleify_app,sampleify_report_worker',routine.signature);
    IF routine.proname IN ('service_agreements_can_read','service_agreements_require_writer','service_agreements_prior_request','service_agreements_save','service_agreements_retire','service_agreements_upload_file','service_agreements_can_read_file') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sampleify_app',routine.signature);
    END IF;
  END LOOP;
END $$;
