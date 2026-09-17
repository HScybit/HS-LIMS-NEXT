-- Native Vendor authoring and typed history. Existing master tables remain unchanged.
CREATE TABLE "vendor_contacts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "vendor_contact_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "vendor_contact_values" CHECK (length(trim("vendor_contacts"."name")) between 1 and 200 and length("vendor_contacts"."email") between 3 and 320
  and "vendor_contacts"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' and length(trim("vendor_contacts"."phone")) between 1 and 50)
);

--> statement-breakpoint
CREATE TABLE "vendor_version_contacts" (
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "vendor_version_contact_pk" PRIMARY KEY("organization_id","vendor_id","revision","id"),
	CONSTRAINT "vendor_version_contact_position" UNIQUE("organization_id","vendor_id","revision","position"),
	CONSTRAINT "vendor_version_contact_order" CHECK ("vendor_version_contacts"."position" between 0 and 99),
	CONSTRAINT "vendor_version_contact_values" CHECK (length(trim("vendor_version_contacts"."name")) between 1 and 200 and length("vendor_version_contacts"."email") between 3 and 320
  and "vendor_version_contacts"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' and length(trim("vendor_version_contacts"."phone")) between 1 and 50)
);

--> statement-breakpoint
CREATE TABLE "vendor_versions" (
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"abbreviation" text,
	"tax_identifier" text,
	"total_balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"custom_field_count" integer DEFAULT 0 NOT NULL,
	"custom_fields_provided" boolean DEFAULT false NOT NULL,
	"request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"contact_count" integer NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "vendor_version_pk" PRIMARY KEY("organization_id","vendor_id","revision"),
	CONSTRAINT "vendor_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "vendor_version_values" CHECK (length(trim("vendor_versions"."code")) between 1 and 64 and "vendor_versions"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim("vendor_versions"."name")) between 1 and 250 and length(trim("vendor_versions"."legal_name")) between 1 and 250
  and ("vendor_versions"."abbreviation" is null or length("vendor_versions"."abbreviation")<=64) and ("vendor_versions"."tax_identifier" is null or length("vendor_versions"."tax_identifier")<=100)
  and "vendor_versions"."total_balance" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
  and (not "vendor_versions"."retired" or not "vendor_versions"."active") and "vendor_versions"."custom_field_count" between 0 and 500),
	CONSTRAINT "vendor_version_revision" CHECK (("vendor_versions"."operation"='create' and "vendor_versions"."previous_revision" is null and "vendor_versions"."revision"=1)
    or ("vendor_versions"."operation" in ('update','retire') and "vendor_versions"."previous_revision">0 and "vendor_versions"."previous_revision" is not null and "vendor_versions"."revision"="vendor_versions"."previous_revision"+1)),
	CONSTRAINT "vendor_version_command" CHECK ("vendor_versions"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "vendor_versions"."contact_count" between 1 and 100
    and ("vendor_versions"."retired"=("vendor_versions"."operation"='retire')) and (not "vendor_versions"."retired" or not "vendor_versions"."custom_fields_provided"))
);

--> statement-breakpoint
CREATE TABLE "vendors" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"abbreviation" text,
	"tax_identifier" text,
	"total_balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"custom_field_count" integer DEFAULT 0 NOT NULL,
	"custom_fields_provided" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"save_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "vendor_values" CHECK (length(trim("vendors"."code")) between 1 and 64 and "vendors"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim("vendors"."name")) between 1 and 250 and length(trim("vendors"."legal_name")) between 1 and 250
  and ("vendors"."abbreviation" is null or length("vendors"."abbreviation")<=64) and ("vendors"."tax_identifier" is null or length("vendors"."tax_identifier")<=100)
  and "vendors"."total_balance" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
  and (not "vendors"."retired" or not "vendors"."active") and "vendors"."custom_field_count" between 0 and 500),
	CONSTRAINT "vendor_revision" CHECK ("vendors"."revision">0)
);

--> statement-breakpoint
CREATE TABLE "vendor_version_custom_field_values" (
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"field_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"raw_kind" text NOT NULL,
	"raw_text" text,
	"raw_number" double precision,
	"raw_boolean" boolean,
	"raw_number_text" text,
	"interpretation_state" text NOT NULL,
	"parsed_number" double precision,
	"parsed_boolean" boolean,
	"parsed_date" date,
	"parsed_timestamp" timestamp with time zone,
	"option_id" uuid,
	"option_revision" integer,
	"user_id" uuid,
	"attachment_id" uuid,
	"lookup_source_id" uuid,
	"lookup_revision" integer,
	"lookup_line_id" text,
	CONSTRAINT "vendor_custom_value_pk" PRIMARY KEY("organization_id","vendor_id","revision","field_id","position"),
	CONSTRAINT "vendor_custom_value_lookup_reference" CHECK (num_nonnulls("vendor_version_custom_field_values"."lookup_source_id","vendor_version_custom_field_values"."lookup_revision","vendor_version_custom_field_values"."lookup_line_id")=0
    or ("vendor_version_custom_field_values"."lookup_source_id" is not null and "vendor_version_custom_field_values"."lookup_revision" is not null and "vendor_version_custom_field_values"."lookup_revision">0 and "vendor_version_custom_field_values"."lookup_line_id" is not null)),
	CONSTRAINT "vendor_custom_value_raw" CHECK ("vendor_version_custom_field_values"."position" between 0 and 499 and num_nonnulls("vendor_version_custom_field_values"."raw_text","vendor_version_custom_field_values"."raw_number","vendor_version_custom_field_values"."raw_boolean")=1
    and (("vendor_version_custom_field_values"."raw_kind"='text' and "vendor_version_custom_field_values"."raw_text" is not null and length("vendor_version_custom_field_values"."raw_text")<=16000)
      or ("vendor_version_custom_field_values"."raw_kind"='number' and "vendor_version_custom_field_values"."raw_number" is not null and "vendor_version_custom_field_values"."raw_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("vendor_version_custom_field_values"."raw_kind"='boolean' and "vendor_version_custom_field_values"."raw_boolean" is not null))),
	CONSTRAINT "vendor_custom_value_number_text" CHECK (case when "vendor_version_custom_field_values"."raw_kind"='number' then
    "vendor_version_custom_field_values"."raw_number_text" is not null and length("vendor_version_custom_field_values"."raw_number_text") between 1 and 32
    and case when "vendor_version_custom_field_values"."raw_number_text" ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then "vendor_version_custom_field_values"."raw_number_text"::double precision="vendor_version_custom_field_values"."raw_number" else false end
    else "vendor_version_custom_field_values"."raw_number_text" is null end),
	CONSTRAINT "vendor_custom_value_interpretation" CHECK ("vendor_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("vendor_version_custom_field_values"."parsed_number" is null or "vendor_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("vendor_version_custom_field_values"."parsed_timestamp" is null or isfinite("vendor_version_custom_field_values"."parsed_timestamp")) and ("vendor_version_custom_field_values"."parsed_date" is null or isfinite("vendor_version_custom_field_values"."parsed_date"))
    and (("vendor_version_custom_field_values"."option_id" is null and "vendor_version_custom_field_values"."option_revision" is null) or ("vendor_version_custom_field_values"."option_id" is not null and "vendor_version_custom_field_values"."option_revision" is not null and "vendor_version_custom_field_values"."option_revision">0))
    and ("vendor_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("vendor_version_custom_field_values"."parsed_number","vendor_version_custom_field_values"."parsed_boolean","vendor_version_custom_field_values"."parsed_date","vendor_version_custom_field_values"."parsed_timestamp","vendor_version_custom_field_values"."option_id","vendor_version_custom_field_values"."option_revision","vendor_version_custom_field_values"."user_id","vendor_version_custom_field_values"."attachment_id","vendor_version_custom_field_values"."lookup_source_id","vendor_version_custom_field_values"."lookup_revision","vendor_version_custom_field_values"."lookup_line_id")=0)
    and (("vendor_version_custom_field_values"."interpretation_state"='empty')=("vendor_version_custom_field_values"."raw_kind"='text' and "vendor_version_custom_field_values"."raw_text"='')))
);

--> statement-breakpoint
CREATE TABLE "vendor_version_custom_fields" (
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"field_id" uuid NOT NULL,
	"field_revision" integer NOT NULL,
	"field_type" text NOT NULL,
	"position" integer NOT NULL,
	"is_array" boolean NOT NULL,
	"value_count" integer NOT NULL,
	"display_kind" text NOT NULL,
	"display_text" text,
	"display_number" double precision,
	"display_boolean" boolean,
	"time_zone" text,
	"time_zone_data_version" text,
	"date_parser_version" text,
	CONSTRAINT "vendor_custom_field_pk" PRIMARY KEY("organization_id","vendor_id","revision","field_id"),
	CONSTRAINT "vendor_custom_field_position" UNIQUE("organization_id","vendor_id","revision","position"),
	CONSTRAINT "vendor_custom_field_shape" CHECK ("vendor_version_custom_fields"."position" between 0 and 499 and "vendor_version_custom_fields"."value_count" between 0 and 500
    and ("vendor_version_custom_fields"."is_array" or "vendor_version_custom_fields"."value_count"=1)
    and "vendor_version_custom_fields"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')),
	CONSTRAINT "vendor_custom_field_display" CHECK (num_nonnulls("vendor_version_custom_fields"."display_text","vendor_version_custom_fields"."display_number","vendor_version_custom_fields"."display_boolean")=1
    and (("vendor_version_custom_fields"."display_kind"='text' and "vendor_version_custom_fields"."display_text" is not null and length("vendor_version_custom_fields"."display_text")<=8000998)
      or ("vendor_version_custom_fields"."display_kind"='number' and "vendor_version_custom_fields"."display_number" is not null and "vendor_version_custom_fields"."display_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("vendor_version_custom_fields"."display_kind"='boolean' and "vendor_version_custom_fields"."display_boolean" is not null))
    and (not "vendor_version_custom_fields"."is_array" or "vendor_version_custom_fields"."display_kind"='text')),
	CONSTRAINT "vendor_custom_field_zone" CHECK (("vendor_version_custom_fields"."field_type" in ('date','date_time') and "vendor_version_custom_fields"."time_zone" is not null
      and length("vendor_version_custom_fields"."time_zone") between 1 and 100 and "vendor_version_custom_fields"."time_zone_data_version" is not null and length("vendor_version_custom_fields"."time_zone_data_version") between 1 and 40
      and "vendor_version_custom_fields"."date_parser_version" is not null and length("vendor_version_custom_fields"."date_parser_version") between 1 and 80)
    or ("vendor_version_custom_fields"."field_type" not in ('date','date_time') and num_nonnulls("vendor_version_custom_fields"."time_zone","vendor_version_custom_fields"."time_zone_data_version","vendor_version_custom_fields"."date_parser_version")=0))
);

--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contact_parent_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_contacts" ADD CONSTRAINT "vendor_version_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_contacts" ADD CONSTRAINT "vendor_version_contact_parent_fk" FOREIGN KEY ("organization_id","vendor_id","revision") REFERENCES "public"."vendor_versions"("organization_id","vendor_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_versions" ADD CONSTRAINT "vendor_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_versions" ADD CONSTRAINT "vendor_version_parent_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_versions" ADD CONSTRAINT "vendor_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_field_values" ADD CONSTRAINT "vendor_version_custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_field_values" ADD CONSTRAINT "vendor_custom_value_field_fk" FOREIGN KEY ("organization_id","vendor_id","revision","field_id") REFERENCES "public"."vendor_version_custom_fields"("organization_id","vendor_id","revision","field_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_field_values" ADD CONSTRAINT "vendor_custom_value_option_fk" FOREIGN KEY ("organization_id","field_id","option_revision","option_id") REFERENCES "public"."custom_field_version_options"("organization_id","field_id","revision","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_field_values" ADD CONSTRAINT "vendor_custom_value_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_field_values" ADD CONSTRAINT "vendor_custom_value_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."custom_field_attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_field_values" ADD CONSTRAINT "vendor_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_fields" ADD CONSTRAINT "vendor_version_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_fields" ADD CONSTRAINT "vendor_custom_field_vendor_fk" FOREIGN KEY ("organization_id","vendor_id","revision") REFERENCES "public"."vendor_versions"("organization_id","vendor_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_version_custom_fields" ADD CONSTRAINT "vendor_custom_field_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_primary_contact_key" ON "vendor_contacts" USING btree ("organization_id","vendor_id") WHERE "vendor_contacts"."is_primary";
--> statement-breakpoint
CREATE INDEX "vendor_contact_parent_idx" ON "vendor_contacts" USING btree ("organization_id","vendor_id","id");
--> statement-breakpoint
CREATE INDEX "vendor_version_contact_identity" ON "vendor_version_contacts" USING btree ("organization_id","id","vendor_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_code_key" ON "vendors" USING btree ("organization_id",lower("code")) WHERE not "vendors"."retired";
--> statement-breakpoint
CREATE INDEX "vendor_scheme_order" ON "vendors" USING btree ("organization_id","created_at","updated_at","id") WHERE not "vendors"."retired";
--> statement-breakpoint
CREATE INDEX "vendor_custom_value_raw_search" ON "vendor_version_custom_field_values" USING btree ("organization_id","field_id",md5("raw_text"),"vendor_id","revision") WHERE "vendor_version_custom_field_values"."raw_text" is not null;
--> statement-breakpoint
CREATE INDEX "vendor_custom_field_definition" ON "vendor_version_custom_fields" USING btree ("organization_id","field_id","vendor_id","revision");
--> statement-breakpoint
CREATE FUNCTION masters_require_vendor_write() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_lock_field_writer();
  PERFORM public.organization_require_module_access('vendor');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION masters_require_vendor_write() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_require_vendor_write() TO sampleify_app;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['vendors','vendor_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY vendor_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT masters_can_read_party(''vendor'')))',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_vendor_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.vendor_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Vendor history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='vendor_versions' THEN
    IF NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.saved_at IS DISTINCT FROM transaction_timestamp()
      OR NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NEW.organization_id IS DISTINCT FROM public.organization_module_scope()
      OR NOT EXISTS (SELECT 1 FROM public.vendors vendor WHERE vendor.organization_id=NEW.organization_id AND vendor.id=NEW.vendor_id
        AND vendor.revision=NEW.revision AND vendor.save_request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'Vendor history requires its actual saved command' USING ERRCODE='23514',CONSTRAINT='vendor_history_transaction';
    END IF;
  ELSE
    SELECT * INTO version FROM public.vendor_versions WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.revision;
    IF version.vendor_id IS NULL OR version.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NEW.organization_id IS DISTINCT FROM public.organization_module_scope() THEN
      RAISE EXCEPTION 'Vendor contacts require their actual save transaction' USING ERRCODE='23514',CONSTRAINT='vendor_history_transaction';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['vendor_versions','vendor_version_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY vendor_history_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT masters_can_read_party(''vendor'')))',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER vendor_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_vendor_history()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_record_vendor(target_vendor uuid,previous_revision integer,operation text,request_fingerprint text,contact_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; saved_revision integer;
BEGIN
  INSERT INTO public.vendor_versions(organization_id,vendor_id,revision,request_id,request_fingerprint,previous_revision,operation,
    code,name,legal_name,abbreviation,tax_identifier,total_balance,active,retired,custom_field_count,custom_fields_provided,contact_count,saved_by)
    SELECT organization_id,id,revision,save_request_id,request_fingerprint,previous_revision,operation,
      code,name,legal_name,abbreviation,tax_identifier,total_balance,active,retired,custom_field_count,custom_fields_provided,
      cardinality(contact_ids),actor FROM public.vendors WHERE organization_id=org AND id=target_vendor
    RETURNING revision INTO saved_revision;
  IF saved_revision IS NULL THEN RAISE EXCEPTION 'Vendor was not found' USING ERRCODE='P0002',CONSTRAINT='vendor_not_found'; END IF;
  INSERT INTO public.vendor_version_contacts(organization_id,vendor_id,revision,id,position,name,email,phone,is_primary)
    SELECT contact.organization_id,contact.vendor_id,saved_revision,contact.id,ordered.position-1,contact.name,contact.email,contact.phone,contact.is_primary
    FROM unnest(contact_ids) WITH ORDINALITY ordered(id,position) JOIN public.vendor_contacts contact
      ON contact.organization_id=org AND contact.vendor_id=target_vendor AND contact.id=ordered.id;
  RETURN saved_revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_check_vendor_relations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE contact_count integer;
BEGIN
  SELECT count(*) INTO contact_count FROM public.vendor_version_contacts WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.revision;
  IF contact_count<>NEW.contact_count OR EXISTS (
    SELECT 1 FROM public.vendor_version_contacts WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.revision AND position>=contact_count
  ) THEN RAISE EXCEPTION 'Vendor contacts require a complete ordered snapshot' USING ERRCODE='23514',CONSTRAINT='vendor_relations_complete'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER vendor_relations_complete AFTER INSERT ON vendor_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_vendor_relations();
--> statement-breakpoint
CREATE FUNCTION masters_vendor_prior_request(target_vendor uuid,expected_revision integer,request_id uuid,request_fingerprint text,requested_operation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior public.vendor_versions;
BEGIN
  PERFORM public.masters_require_vendor_write();
  IF target_vendor IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR request_id IS NULL
    OR request_fingerprint IS NULL OR request_fingerprint !~ '^[a-f0-9]{64}$' OR requested_operation IS NULL
    OR requested_operation NOT IN ('create','update','retire') THEN
    RAISE EXCEPTION 'Invalid Vendor command' USING ERRCODE='23514',CONSTRAINT='vendor_command_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('vendor-save:'||org::text||':'||request_id::text,0));
  SELECT * INTO prior FROM public.vendor_versions version WHERE version.organization_id=org AND version.request_id=masters_vendor_prior_request.request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.vendor_id IS DISTINCT FROM target_vendor OR coalesce(prior.previous_revision,0) IS DISTINCT FROM expected_revision
    OR prior.operation IS DISTINCT FROM requested_operation OR prior.request_fingerprint IS DISTINCT FROM request_fingerprint
    OR prior.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Vendor request was already used for another change' USING ERRCODE='23514',CONSTRAINT='vendor_request_reused';
  END IF;
  RETURN prior.revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_save_vendor(target_vendor uuid,expected_revision integer,request_id uuid,request_fingerprint text,
  code text,name text,legal_name text,abbreviation text,tax_identifier text,total_balance numeric,active boolean,custom_field_count integer,custom_fields_provided boolean,
  contact_ids uuid[],contact_names text[],contact_emails text[],contact_phones text[],contact_primaries boolean[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); current_vendor public.vendors; prior integer; contact_count integer:=cardinality(contact_ids);
BEGIN
  prior:=public.masters_vendor_prior_request(target_vendor,expected_revision,request_id,request_fingerprint,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO current_vendor FROM public.vendors WHERE organization_id=org AND id=target_vendor FOR UPDATE;
  IF expected_revision>0 AND (current_vendor.id IS NULL OR current_vendor.retired) THEN
    RAISE EXCEPTION 'Vendor was not found' USING ERRCODE='P0002',CONSTRAINT='vendor_not_found';
  END IF;
  IF coalesce(current_vendor.revision,0)<>expected_revision THEN
    RAISE EXCEPTION 'Vendor changed; reload before saving' USING ERRCODE='40001',CONSTRAINT='vendor_stale_revision';
  END IF;
  IF NOT coalesce(length(trim(code)) BETWEEN 1 AND 64 AND code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND length(trim(name)) BETWEEN 1 AND 250 AND length(trim(legal_name)) BETWEEN 1 AND 250
    AND (abbreviation IS NULL OR length(abbreviation)<=64) AND (tax_identifier IS NULL OR length(tax_identifier)<=100)
    AND total_balance NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND active IS NOT NULL
    AND custom_field_count BETWEEN 0 AND 500 AND custom_fields_provided IS NOT NULL,false) THEN
    RAISE EXCEPTION 'Invalid Vendor details' USING ERRCODE='23514',CONSTRAINT='vendor_command_input';
  END IF;
  IF NOT coalesce(contact_count BETWEEN 1 AND 100 AND cardinality(contact_names)=contact_count AND cardinality(contact_emails)=contact_count
    AND cardinality(contact_phones)=contact_count AND cardinality(contact_primaries)=contact_count,false)
    OR (SELECT count(DISTINCT id) FROM unnest(contact_ids) ids(id))<>contact_count THEN
    RAISE EXCEPTION 'Invalid Vendor contacts' USING ERRCODE='23514',CONSTRAINT='vendor_relation_input';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_contacts WHERE organization_id=org AND id=ANY(contact_ids) AND vendor_id<>target_vendor)
    OR EXISTS (SELECT 1 FROM public.vendor_version_contacts WHERE organization_id=org AND id=ANY(contact_ids) AND vendor_id<>target_vendor) THEN
    RAISE EXCEPTION 'Vendor contacts cannot be reassigned' USING ERRCODE='23514',CONSTRAINT='vendor_relation_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(contact_ids,contact_names,contact_emails,contact_phones,contact_primaries) incoming(id,name,email,phone,is_primary)
    WHERE NOT coalesce(length(trim(incoming.name)) BETWEEN 1 AND 200 AND length(incoming.email) BETWEEN 3 AND 320
      AND incoming.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      AND length(trim(incoming.phone)) BETWEEN 1 AND 50 AND incoming.is_primary IS NOT NULL,false)
  ) OR (SELECT count(*) FROM unnest(contact_primaries) flags(is_primary) WHERE is_primary)>1 THEN
    RAISE EXCEPTION 'Invalid Vendor contact values' USING ERRCODE='23514',CONSTRAINT='vendor_relation_input';
  END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.vendors(organization_id,id,code,name,legal_name,abbreviation,tax_identifier,total_balance,active,save_request_id,custom_field_count,custom_fields_provided)
      VALUES(org,target_vendor,code,name,legal_name,abbreviation,tax_identifier,total_balance,active,request_id,custom_field_count,custom_fields_provided);
  ELSE
    UPDATE public.vendors vendor SET code=masters_save_vendor.code,name=masters_save_vendor.name,legal_name=masters_save_vendor.legal_name,
      abbreviation=masters_save_vendor.abbreviation,tax_identifier=masters_save_vendor.tax_identifier,total_balance=masters_save_vendor.total_balance,
      active=masters_save_vendor.active,save_request_id=request_id,custom_field_count=masters_save_vendor.custom_field_count,
      custom_fields_provided=masters_save_vendor.custom_fields_provided,revision=vendor.revision+1,updated_at=transaction_timestamp()
      WHERE vendor.organization_id=org AND vendor.id=target_vendor;
  END IF;
  -- Update retained contacts in place and clear old primary flags before switching.
  DELETE FROM public.vendor_contacts WHERE organization_id=org AND vendor_id=target_vendor AND NOT(id=ANY(contact_ids));
  UPDATE public.vendor_contacts SET is_primary=false WHERE organization_id=org AND vendor_id=target_vendor AND is_primary;
  INSERT INTO public.vendor_contacts(organization_id,vendor_id,id,name,email,phone,is_primary)
    SELECT org,target_vendor,* FROM unnest(contact_ids,contact_names,contact_emails,contact_phones,contact_primaries)
    ON CONFLICT(organization_id,id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,is_primary=excluded.is_primary
    WHERE vendor_contacts.vendor_id=target_vendor;
  RETURN public.masters_record_vendor(target_vendor,nullif(expected_revision,0),CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END,request_fingerprint,contact_ids);
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_retire_vendor(target_vendor uuid,expected_revision integer,request_id uuid,request_fingerprint text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); current_vendor public.vendors; prior integer; contact_ids uuid[];
BEGIN
  prior:=public.masters_vendor_prior_request(target_vendor,expected_revision,request_id,request_fingerprint,'retire');
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO current_vendor FROM public.vendors WHERE organization_id=org AND id=target_vendor FOR UPDATE;
  IF current_vendor.id IS NULL OR current_vendor.retired THEN RAISE EXCEPTION 'Vendor was not found' USING ERRCODE='P0002',CONSTRAINT='vendor_not_found'; END IF;
  IF current_vendor.revision<>expected_revision THEN RAISE EXCEPTION 'Vendor changed; reload before deleting' USING ERRCODE='40001',CONSTRAINT='vendor_stale_revision'; END IF;
  SELECT array_agg(contact.id ORDER BY saved.position NULLS LAST,contact.id) INTO contact_ids FROM public.vendor_contacts contact
    LEFT JOIN public.vendor_version_contacts saved ON saved.organization_id=contact.organization_id AND saved.vendor_id=contact.vendor_id
      AND saved.id=contact.id AND saved.revision=current_vendor.revision WHERE contact.organization_id=org AND contact.vendor_id=target_vendor;
  UPDATE public.vendors SET retired=true,active=false,revision=revision+1,save_request_id=request_id,custom_fields_provided=false,
    updated_at=transaction_timestamp() WHERE organization_id=org AND id=target_vendor;
  RETURN public.masters_record_vendor(target_vendor,expected_revision,'retire',request_fingerprint,contact_ids);
END $$;
--> statement-breakpoint
DO $$ DECLARE routine regprocedure; BEGIN
  FOR routine IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname=ANY(ARRAY['masters_guard_vendor_history','masters_record_vendor','masters_check_vendor_relations','masters_vendor_prior_request','masters_save_vendor','masters_retire_vendor']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,sampleify_app,sampleify_report_worker',routine);
  END LOOP;
  FOR routine IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname=ANY(ARRAY['masters_vendor_prior_request','masters_save_vendor','masters_retire_vendor']) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sampleify_app',routine);
  END LOOP;
END $$;

--> statement-breakpoint
CREATE FUNCTION masters_assert_vendor_custom_fields(target_organization uuid,target_vendor uuid,target_revision integer,check_definition_set boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.vendor_versions; field_count integer; minimum_position integer; maximum_position integer; item_count integer;
BEGIN
  SELECT * INTO version FROM public.vendor_versions
    WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor Custom Field history is missing' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_complete'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(value_count),0) INTO field_count,minimum_position,maximum_position,item_count
    FROM public.vendor_version_custom_fields
    WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision;
  IF field_count<>version.custom_field_count OR item_count>5000
    OR (field_count>0 AND (minimum_position<>0 OR maximum_position<>field_count-1)) THEN
    RAISE EXCEPTION 'Vendor Custom Fields require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_complete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vendor_version_custom_fields field LEFT JOIN LATERAL (
      SELECT count(*) AS count,min(position) AS minimum,max(position) AS maximum
      FROM public.vendor_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.vendor_id=field.vendor_id
        AND value.revision=field.revision AND value.field_id=field.field_id
    ) items ON true
    WHERE field.organization_id=target_organization AND field.vendor_id=target_vendor AND field.revision=target_revision
      AND (items.count<>field.value_count OR (items.count>0 AND (items.minimum<>0 OR items.maximum<>items.count-1)))
  ) THEN RAISE EXCEPTION 'Vendor Custom Field items require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_complete'; END IF;
  IF version.custom_fields_provided THEN
    IF check_definition_set AND (EXISTS (
      SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='vendor'
      EXCEPT SELECT field_id,field_revision FROM public.vendor_version_custom_fields
        WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision
    ) OR EXISTS (
      SELECT field_id,field_revision FROM public.vendor_version_custom_fields
        WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision
      EXCEPT SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='vendor'
    )) THEN RAISE EXCEPTION 'Vendor Custom Field definitions changed' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_definition_set'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.vendor_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      WHERE field.organization_id=target_organization AND field.vendor_id=target_vendor AND field.revision=target_revision AND definition.is_required
      AND NOT (
        (field.is_array AND definition.field_type<>'multi_user_select'
          AND (NOT definition.allows_multiple OR definition.field_type='attachment'))
        OR EXISTS (
        SELECT 1 FROM public.vendor_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.vendor_id=field.vendor_id AND value.revision=field.revision AND value.field_id=field.field_id
          AND CASE
            WHEN definition.field_type='multi_user_select'
              OR (definition.allows_multiple AND definition.field_type IN ('select','lookup')) THEN field.is_array
            WHEN definition.allows_multiple AND definition.field_type<>'attachment' AND NOT field.is_array THEN false
            WHEN NOT field.is_array THEN value.raw_kind<>'text' OR value.raw_text<>''
            WHEN value.raw_kind='boolean' THEN value.raw_boolean
            WHEN value.raw_kind='number' THEN true
            ELSE public.masters_custom_field_trim(value.raw_text)<>''
          END
        )
      )
    ) THEN RAISE EXCEPTION 'A required Vendor Custom Field is empty' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_required'; END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_vendor_custom_field_uniqueness(target_organization uuid,target_vendor uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.vendor_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=target_organization AND field.vendor_id=target_vendor AND field.revision=target_revision
      AND definition.validate_uniqueness
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.vendor_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.vendor_version_custom_field_values value ON value.organization_id=field.organization_id AND value.vendor_id=field.vendor_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.vendor_id=target_vendor AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.vendor_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.vendor_version_custom_field_values value ON value.organization_id=field.organization_id AND value.vendor_id=field.vendor_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.vendor_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.vendors vendor ON vendor.organization_id=existing.organization_id AND vendor.id=existing.vendor_id AND vendor.revision=existing.revision AND NOT vendor.retired
    WHERE field.organization_id=target_organization AND field.vendor_id=target_vendor AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.vendor_id<>target_vendor
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_vendor_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer;
BEGIN
  PERFORM public.masters_require_vendor_write();
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() THEN
    RAISE EXCEPTION 'Vendor fields require the authenticated organization' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.vendor_versions WHERE organization_id=OLD.organization_id AND vendor_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_vendor_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF NEW.retired AND NEW.custom_fields_provided THEN
    RAISE EXCEPTION 'Vendor retirement preserves Custom Fields' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_preserve';
  END IF;
  IF NEW.custom_fields_provided THEN
    SELECT count(*) INTO expected_count FROM public.custom_field_definitions
      WHERE organization_id=NEW.organization_id AND associated_with='vendor' AND active;
    IF expected_count<>NEW.custom_field_count THEN
      RAISE EXCEPTION 'Provide the current Vendor Custom Fields' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_definition_set';
    END IF;
  ELSE
    expected_count := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.custom_field_count END;
    IF NEW.custom_field_count<>expected_count OR (NOT NEW.retired AND EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND associated_with='vendor' AND active
    )) THEN RAISE EXCEPTION 'Vendor Custom Field omission requires no current definitions' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_preserve'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_custom_field_change BEFORE INSERT OR UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION masters_guard_vendor_custom_field_change();
--> statement-breakpoint
CREATE FUNCTION masters_initialize_vendor_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE vendor public.vendors;
BEGIN
  SELECT * INTO vendor FROM public.vendors WHERE organization_id=NEW.organization_id AND id=NEW.vendor_id AND revision=NEW.revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor field history requires its actual Vendor revision' USING ERRCODE='23514'; END IF;
  NEW.custom_field_count := vendor.custom_field_count;
  NEW.custom_fields_provided := vendor.custom_fields_provided;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_custom_field_metadata BEFORE INSERT ON vendor_versions FOR EACH ROW EXECUTE FUNCTION masters_initialize_vendor_custom_field_metadata();
--> statement-breakpoint
CREATE FUNCTION masters_guard_vendor_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.vendor_versions; field public.vendor_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Vendor Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.vendor_versions WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.revision;
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR version.vendor_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.vendors WHERE organization_id=NEW.organization_id AND id=NEW.vendor_id
        AND revision=NEW.revision AND save_request_id=version.request_id)) THEN
    RAISE EXCEPTION 'Vendor Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='vendor_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Vendor Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Vendor Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='vendor' AND active
    ) THEN RAISE EXCEPTION 'Select the current Vendor Custom Field revision' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.vendor_version_custom_fields
      WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Vendor Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Vendor Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.vendor_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.vendor_id=NEW.vendor_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
      END IF;
    ELSIF field.field_type='select' AND version.previous_revision>0 AND (
      NEW.interpretation_state='invalid' OR version.custom_fields_provided AND NEW.option_revision<>field.field_revision
    ) THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      -- Restrict prior items to the same saved key before checking their raw values.
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          SELECT field_id FROM public.vendor_version_custom_fields
            WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    ELSIF field.field_type='attachment' AND NEW.interpretation_state='valid' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF version.previous_revision>0 THEN
        WITH key_definitions AS MATERIALIZED (
          SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
        ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
          FROM key_definitions previous_definition JOIN LATERAL (
            SELECT field_id FROM public.vendor_version_custom_fields
              WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=version.previous_revision
                AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
          ) previous_field ON true;
      END IF;
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id,NEW.lookup_source_id,NEW.lookup_revision,NEW.lookup_line_id);
    IF NEW.interpretation_state='valid' THEN
      CASE field.field_type
        WHEN 'number' THEN
          IF NEW.parsed_number IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A numeric field requires its typed numeric interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'checkbox' THEN
          IF NEW.parsed_boolean IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A checkbox requires its typed boolean interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'date' THEN
          IF NEW.parsed_date IS NULL OR NEW.parsed_timestamp IS NULL OR related_count<>2 THEN RAISE EXCEPTION 'A date requires its local date and parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'date_time' THEN
          IF NEW.parsed_timestamp IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A date-time field requires its parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'select' THEN
          IF NEW.option_id IS NULL OR NEW.option_revision IS NULL OR related_count<>2 OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
              AND option.field_id=NEW.field_id AND option.revision=NEW.option_revision AND option.id=NEW.option_id
              AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.vendor_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.vendor_id=NEW.vendor_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Vendor revision' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with='vendor' AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.vendor_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.vendor_id=NEW.vendor_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN
          IF NEW.lookup_source_id IS NULL OR NEW.lookup_revision IS NULL OR NEW.lookup_line_id IS NULL OR related_count<>3
            OR definition.lookup_source_id IS DISTINCT FROM NEW.lookup_source_id
            OR NEW.lookup_line_id IS DISTINCT FROM (CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END)
            OR NOT EXISTS (
              SELECT 1 FROM public.custom_field_lookup_lines line
              WHERE line.organization_id=NEW.organization_id AND line.source_id=NEW.lookup_source_id
                AND line.revision=NEW.lookup_revision AND line.original_line_id=NEW.lookup_line_id
                AND (NOT version.custom_fields_provided OR EXISTS (
                  SELECT 1 FROM public.custom_field_lookup_sources source
                    WHERE source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
                ))
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Keep an unavailable saved value without claiming a foreign definition's option.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.vendor_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.vendor_id=NEW.vendor_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.vendor_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.vendor_id=NEW.vendor_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='vendor_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['vendor_version_custom_fields','vendor_version_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY vendor_custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope())
        AND (SELECT masters_can_read_party(''vendor'')))',relation);
    EXECUTE format('CREATE POLICY vendor_custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT masters_require_vendor_write()))',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_report_worker',relation);
    EXECUTE format('CREATE TRIGGER vendor_custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_vendor_custom_field_history()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_vendor_custom_field_preservation(target_organization uuid,target_vendor uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.vendor_versions;
BEGIN
  SELECT * INTO version FROM public.vendor_versions WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","vendor_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.vendor_version_custom_fields WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision EXCEPT SELECT "organization_id","vendor_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.vendor_version_custom_fields WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","vendor_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.vendor_version_custom_fields WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=version.previous_revision EXCEPT SELECT "organization_id","vendor_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.vendor_version_custom_fields WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision) OR EXISTS (SELECT "organization_id","vendor_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.vendor_version_custom_field_values WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision EXCEPT SELECT "organization_id","vendor_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.vendor_version_custom_field_values WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","vendor_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.vendor_version_custom_field_values WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=version.previous_revision EXCEPT SELECT "organization_id","vendor_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.vendor_version_custom_field_values WHERE organization_id=target_organization AND vendor_id=target_vendor AND revision=target_revision) THEN
    RAISE EXCEPTION 'Vendor Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='vendor_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_preserve_vendor_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.vendor_version_custom_fields("organization_id","vendor_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","vendor_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.vendor_version_custom_fields
    WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.previous_revision;
  INSERT INTO public.vendor_version_custom_field_values("organization_id","vendor_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id")
    SELECT "organization_id","vendor_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.vendor_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_check_vendor_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_vendor_custom_fields(NEW.organization_id,NEW.vendor_id,NEW.revision,true);
  PERFORM public.masters_assert_vendor_custom_field_preservation(NEW.organization_id,NEW.vendor_id,NEW.revision);
  IF NEW.custom_fields_provided THEN PERFORM public.masters_assert_vendor_custom_field_uniqueness(NEW.organization_id,NEW.vendor_id,NEW.revision); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER vendor_custom_fields_preserve AFTER INSERT ON vendor_versions FOR EACH ROW EXECUTE FUNCTION masters_preserve_vendor_custom_fields();
CREATE CONSTRAINT TRIGGER vendor_custom_fields_complete AFTER INSERT ON vendor_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_vendor_custom_fields();
REVOKE ALL ON FUNCTION masters_assert_vendor_custom_fields(uuid,uuid,integer,boolean),masters_guard_vendor_custom_field_change(),
  masters_initialize_vendor_custom_field_metadata(),masters_guard_vendor_custom_field_history(),masters_assert_vendor_custom_field_uniqueness(uuid,uuid,integer),
  masters_assert_vendor_custom_field_preservation(uuid,uuid,integer),masters_preserve_vendor_custom_fields(),masters_check_vendor_custom_fields()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
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
    OR definition.associated_with NOT IN ('product','parameter','method_of_analysis','users','customer','vendor') OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires a current active supported field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  IF definition.associated_with IN ('customer','vendor') THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'Party master attachments require their upload command' USING ERRCODE='42501'; END IF;
    IF definition.associated_with='customer' THEN PERFORM public.masters_require_customer_write();
    ELSE PERFORM public.masters_require_vendor_write(); END IF;
    IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope()
      OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'Party master attachments require the actual organization, editor and transaction' USING ERRCODE='42501';
    END IF;
  ELSIF definition.associated_with='users' THEN
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
-- Party master attachments share the typed byte store, but require configured
-- Customer access for reads and their native upload command for writes.
ALTER POLICY custom_field_attachment_read ON custom_field_attachments USING (
  organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope())
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage'))
  AND EXISTS (SELECT 1 FROM custom_field_versions definition
    WHERE definition.organization_id=custom_field_attachments.organization_id AND definition.field_id=custom_field_attachments.field_id
      AND definition.revision=custom_field_attachments.field_revision AND definition.field_type='attachment'
      AND (definition.associated_with IN ('product','parameter','method_of_analysis')
        OR definition.associated_with='customer' AND (SELECT masters_can_read_party('customer'))
        OR definition.associated_with='vendor' AND (SELECT masters_can_read_party('vendor'))))
);
--> statement-breakpoint
CREATE FUNCTION masters_upload_vendor_attachment(target_id uuid,target_field uuid,target_revision integer,file_name text,file_type text,file_content bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid; prior public.custom_field_attachments; definition public.custom_field_definitions;
BEGIN
  PERFORM public.masters_require_vendor_write();
  actor:=nullif(current_setting('app.user_id',true),'')::uuid;
  IF target_id IS NULL OR target_field IS NULL OR target_revision IS NULL OR target_revision<1 OR file_content IS NULL OR octet_length(file_content)>20971520 THEN
    RAISE EXCEPTION 'Invalid Vendor attachment' USING ERRCODE='23514',CONSTRAINT='vendor_attachment_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||org::text||':'||target_id::text,0));
  SELECT * INTO prior FROM public.custom_field_attachments WHERE organization_id=org AND id=target_id;
  IF FOUND THEN
    IF (prior.field_id,prior.field_revision,prior.original_name,prior.media_type,prior.content,prior.uploaded_by)
      IS DISTINCT FROM (target_field,target_revision,file_name,file_type,file_content,actor)
      OR NOT EXISTS (SELECT 1 FROM public.custom_field_versions WHERE organization_id=org AND field_id=prior.field_id AND revision=prior.field_revision AND associated_with='vendor') THEN
      RAISE EXCEPTION 'Attachment request already used' USING ERRCODE='23514',CONSTRAINT='vendor_attachment_request_reused';
    END IF;
    RETURN true;
  END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=org AND id=target_field;
  IF definition.id IS NULL OR NOT definition.active OR definition.associated_with<>'vendor' OR definition.field_type<>'attachment' THEN
    RAISE EXCEPTION 'Vendor attachment field was not found' USING ERRCODE='P0002',CONSTRAINT='vendor_attachment_field_not_found';
  END IF;
  IF definition.revision<>target_revision THEN RAISE EXCEPTION 'Custom Field changed' USING ERRCODE='23514',CONSTRAINT='vendor_attachment_field_changed'; END IF;
  INSERT INTO public.custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,target_id,target_field,target_revision,file_name,file_type,file_content,octet_length(file_content),encode(sha256(file_content),'hex'),actor);
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION masters_upload_vendor_attachment(uuid,uuid,integer,text,text,bytea) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_upload_vendor_attachment(uuid,uuid,integer,text,text,bytea) TO sampleify_app;

--> statement-breakpoint
CREATE FUNCTION masters_vendor_scheme_context(include_vendors boolean,include_samples boolean)
RETURNS TABLE("currentYearDigits" text,"nextYearDigits" text,separator text,"currentMonthFormat" text,"nonNablStartNumber" text,
  "vendorCount" double precision,"sampleCount" double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('masters.manage') OR NOT public.organization_has_module_access('vendor') THEN
    RAISE EXCEPTION 'Vendor scheme generation requires permission' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.scheme_current_year_digits,settings.scheme_next_year_digits,settings.scheme_separator,
    settings.scheme_month_format,settings.scheme_non_nabl_start_number,
    CASE WHEN include_vendors THEN (SELECT count(*)::double precision FROM public.vendors vendor WHERE vendor.organization_id=org AND NOT vendor.retired) ELSE 0::double precision END,
    CASE WHEN include_samples THEN (SELECT count(*)::double precision FROM public.samples sample WHERE sample.organization_id=org) ELSE 0::double precision END
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=org;
END $$;
REVOKE ALL ON FUNCTION masters_vendor_scheme_context(boolean,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_vendor_scheme_context(boolean,boolean) TO sampleify_app;
