-- Customer master commands, immutable typed history and configured field capture.
CREATE TABLE "customer_version_addresses" (
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"address_type" text NOT NULL,
	"attention_to" text,
	"line_1" text,
	"line_2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country_code" text,
	"freeform_address" text,
	"is_default" boolean NOT NULL,
	CONSTRAINT "customer_version_address_pk" PRIMARY KEY("organization_id","customer_id","revision","id"),
	CONSTRAINT "customer_version_address_position" UNIQUE("organization_id","customer_id","revision","position"),
	CONSTRAINT "customer_version_address_order" CHECK ("customer_version_addresses"."position">=0)
);

--> statement-breakpoint
CREATE TABLE "customer_version_contacts" (
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"designation" text,
	"is_primary" boolean NOT NULL,
	CONSTRAINT "customer_version_contact_pk" PRIMARY KEY("organization_id","customer_id","revision","id"),
	CONSTRAINT "customer_version_contact_position" UNIQUE("organization_id","customer_id","revision","position"),
	CONSTRAINT "customer_version_contact_order" CHECK ("customer_version_contacts"."position">=0)
);

--> statement-breakpoint
CREATE TABLE "customer_version_custom_field_values" (
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
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
	CONSTRAINT "customer_custom_value_pk" PRIMARY KEY("organization_id","customer_id","revision","field_id","position"),
	CONSTRAINT "customer_custom_value_lookup_reference" CHECK (num_nonnulls("customer_version_custom_field_values"."lookup_source_id","customer_version_custom_field_values"."lookup_revision","customer_version_custom_field_values"."lookup_line_id")=0
    or ("customer_version_custom_field_values"."lookup_source_id" is not null and "customer_version_custom_field_values"."lookup_revision" is not null and "customer_version_custom_field_values"."lookup_revision">0 and "customer_version_custom_field_values"."lookup_line_id" is not null)),
	CONSTRAINT "customer_custom_value_raw" CHECK ("customer_version_custom_field_values"."position" between 0 and 499 and num_nonnulls("customer_version_custom_field_values"."raw_text","customer_version_custom_field_values"."raw_number","customer_version_custom_field_values"."raw_boolean")=1
    and (("customer_version_custom_field_values"."raw_kind"='text' and "customer_version_custom_field_values"."raw_text" is not null and length("customer_version_custom_field_values"."raw_text")<=16000)
      or ("customer_version_custom_field_values"."raw_kind"='number' and "customer_version_custom_field_values"."raw_number" is not null and "customer_version_custom_field_values"."raw_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("customer_version_custom_field_values"."raw_kind"='boolean' and "customer_version_custom_field_values"."raw_boolean" is not null))),
	CONSTRAINT "customer_custom_value_number_text" CHECK (case when "customer_version_custom_field_values"."raw_kind"='number' then
    "customer_version_custom_field_values"."raw_number_text" is not null and length("customer_version_custom_field_values"."raw_number_text") between 1 and 32
    and case when "customer_version_custom_field_values"."raw_number_text" ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then "customer_version_custom_field_values"."raw_number_text"::double precision="customer_version_custom_field_values"."raw_number" else false end
    else "customer_version_custom_field_values"."raw_number_text" is null end),
	CONSTRAINT "customer_custom_value_interpretation" CHECK ("customer_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("customer_version_custom_field_values"."parsed_number" is null or "customer_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("customer_version_custom_field_values"."parsed_timestamp" is null or isfinite("customer_version_custom_field_values"."parsed_timestamp")) and ("customer_version_custom_field_values"."parsed_date" is null or isfinite("customer_version_custom_field_values"."parsed_date"))
    and (("customer_version_custom_field_values"."option_id" is null and "customer_version_custom_field_values"."option_revision" is null) or ("customer_version_custom_field_values"."option_id" is not null and "customer_version_custom_field_values"."option_revision" is not null and "customer_version_custom_field_values"."option_revision">0))
    and ("customer_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("customer_version_custom_field_values"."parsed_number","customer_version_custom_field_values"."parsed_boolean","customer_version_custom_field_values"."parsed_date","customer_version_custom_field_values"."parsed_timestamp","customer_version_custom_field_values"."option_id","customer_version_custom_field_values"."option_revision","customer_version_custom_field_values"."user_id","customer_version_custom_field_values"."attachment_id","customer_version_custom_field_values"."lookup_source_id","customer_version_custom_field_values"."lookup_revision","customer_version_custom_field_values"."lookup_line_id")=0)
    and (("customer_version_custom_field_values"."interpretation_state"='empty')=("customer_version_custom_field_values"."raw_kind"='text' and "customer_version_custom_field_values"."raw_text"='')))
);

--> statement-breakpoint
CREATE TABLE "customer_version_custom_fields" (
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
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
	CONSTRAINT "customer_custom_field_pk" PRIMARY KEY("organization_id","customer_id","revision","field_id"),
	CONSTRAINT "customer_custom_field_position" UNIQUE("organization_id","customer_id","revision","position"),
	CONSTRAINT "customer_custom_field_shape" CHECK ("customer_version_custom_fields"."position" between 0 and 499 and "customer_version_custom_fields"."value_count" between 0 and 500
    and ("customer_version_custom_fields"."is_array" or "customer_version_custom_fields"."value_count"=1)
    and "customer_version_custom_fields"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')),
	CONSTRAINT "customer_custom_field_display" CHECK (num_nonnulls("customer_version_custom_fields"."display_text","customer_version_custom_fields"."display_number","customer_version_custom_fields"."display_boolean")=1
    and (("customer_version_custom_fields"."display_kind"='text' and "customer_version_custom_fields"."display_text" is not null and length("customer_version_custom_fields"."display_text")<=8000998)
      or ("customer_version_custom_fields"."display_kind"='number' and "customer_version_custom_fields"."display_number" is not null and "customer_version_custom_fields"."display_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("customer_version_custom_fields"."display_kind"='boolean' and "customer_version_custom_fields"."display_boolean" is not null))
    and (not "customer_version_custom_fields"."is_array" or "customer_version_custom_fields"."display_kind"='text')),
	CONSTRAINT "customer_custom_field_zone" CHECK (("customer_version_custom_fields"."field_type" in ('date','date_time') and "customer_version_custom_fields"."time_zone" is not null
      and length("customer_version_custom_fields"."time_zone") between 1 and 100 and "customer_version_custom_fields"."time_zone_data_version" is not null and length("customer_version_custom_fields"."time_zone_data_version") between 1 and 40
      and "customer_version_custom_fields"."date_parser_version" is not null and length("customer_version_custom_fields"."date_parser_version") between 1 and 80)
    or ("customer_version_custom_fields"."field_type" not in ('date','date_time') and num_nonnulls("customer_version_custom_fields"."time_zone","customer_version_custom_fields"."time_zone_data_version","customer_version_custom_fields"."date_parser_version")=0))
);

--> statement-breakpoint
CREATE TABLE "customer_versions" (
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"request_fingerprint" text,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"abbreviation" text,
	"tax_identifier" text,
	"credit_days" integer NOT NULL,
	"total_balance" numeric(20, 2) NOT NULL,
	"default_invoice_notes" text,
	"feedback_applicable" boolean NOT NULL,
	"igst_percent" numeric(7, 4) NOT NULL,
	"sgst_percent" numeric(7, 4) NOT NULL,
	"cgst_percent" numeric(7, 4) NOT NULL,
	"discount_percent" numeric(7, 4) NOT NULL,
	"is_kaleen_bandhu" boolean NOT NULL,
	"active" boolean NOT NULL,
	"retired" boolean NOT NULL,
	"save_source" text NOT NULL,
	"custom_field_count" integer NOT NULL,
	"custom_fields_provided" boolean NOT NULL,
	"address_count" integer NOT NULL,
	"contact_count" integer NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "customer_version_pk" PRIMARY KEY("organization_id","customer_id","revision"),
	CONSTRAINT "customer_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "customer_version_revision" CHECK (("customer_versions"."operation"='create' and "customer_versions"."previous_revision" is null and "customer_versions"."revision"=1)
    or ("customer_versions"."operation" in ('update','retire') and "customer_versions"."previous_revision" is not null and "customer_versions"."previous_revision">0 and "customer_versions"."revision"="customer_versions"."previous_revision"+1)),
	CONSTRAINT "customer_version_fields" CHECK (length(trim("customer_versions"."code")) between 1 and 64 and length(trim("customer_versions"."name")) between 1 and 250 and length(trim("customer_versions"."legal_name")) between 1 and 250
    and "customer_versions"."credit_days" between 0 and 3650 and "customer_versions"."total_balance" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
    and "customer_versions"."igst_percent" between 0 and 100 and "customer_versions"."sgst_percent" between 0 and 100 and "customer_versions"."cgst_percent" between 0 and 100 and "customer_versions"."discount_percent" between 0 and 100
    and ("customer_versions"."retired"=("customer_versions"."operation"='retire')) and (not "customer_versions"."retired" or (not "customer_versions"."active" and not "customer_versions"."custom_fields_provided"))
    and "customer_versions"."address_count">=0 and "customer_versions"."contact_count">=0 and "customer_versions"."custom_field_count" between 0 and 500
    and (("customer_versions"."save_source"='master' and "customer_versions"."request_fingerprint" is not null and "customer_versions"."request_fingerprint" ~ '^[a-f0-9]{64}$')
      or ("customer_versions"."save_source"='registration' and "customer_versions"."operation"='create' and "customer_versions"."request_fingerprint" is null and not "customer_versions"."custom_fields_provided" and "customer_versions"."custom_field_count"=0)))
);

--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "total_balance" numeric(20, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "default_invoice_notes" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "feedback_applicable" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "igst_percent" numeric(7, 4) DEFAULT '18' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "sgst_percent" numeric(7, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "cgst_percent" numeric(7, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "discount_percent" numeric(7, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_kaleen_bandhu" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "retired" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "save_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "save_source" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_version_addresses" ADD CONSTRAINT "customer_version_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_addresses" ADD CONSTRAINT "customer_version_address_parent_fk" FOREIGN KEY ("organization_id","customer_id","revision") REFERENCES "public"."customer_versions"("organization_id","customer_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_contacts" ADD CONSTRAINT "customer_version_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_contacts" ADD CONSTRAINT "customer_version_contact_parent_fk" FOREIGN KEY ("organization_id","customer_id","revision") REFERENCES "public"."customer_versions"("organization_id","customer_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_field_values" ADD CONSTRAINT "customer_version_custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_field_values" ADD CONSTRAINT "customer_custom_value_field_fk" FOREIGN KEY ("organization_id","customer_id","revision","field_id") REFERENCES "public"."customer_version_custom_fields"("organization_id","customer_id","revision","field_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_field_values" ADD CONSTRAINT "customer_custom_value_option_fk" FOREIGN KEY ("organization_id","field_id","option_revision","option_id") REFERENCES "public"."custom_field_version_options"("organization_id","field_id","revision","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_field_values" ADD CONSTRAINT "customer_custom_value_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_field_values" ADD CONSTRAINT "customer_custom_value_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."custom_field_attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_field_values" ADD CONSTRAINT "customer_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_fields" ADD CONSTRAINT "customer_version_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_fields" ADD CONSTRAINT "customer_custom_field_customer_fk" FOREIGN KEY ("organization_id","customer_id","revision") REFERENCES "public"."customer_versions"("organization_id","customer_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_version_custom_fields" ADD CONSTRAINT "customer_custom_field_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_versions" ADD CONSTRAINT "customer_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_versions" ADD CONSTRAINT "customer_version_parent_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_versions" ADD CONSTRAINT "customer_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "customer_version_address_identity" ON "customer_version_addresses" USING btree ("organization_id","id","customer_id");
--> statement-breakpoint
CREATE INDEX "customer_version_contact_identity" ON "customer_version_contacts" USING btree ("organization_id","id","customer_id");
--> statement-breakpoint
CREATE INDEX "customer_custom_value_raw_search" ON "customer_version_custom_field_values" USING btree ("organization_id","field_id",md5("raw_text"),"customer_id","revision") WHERE "customer_version_custom_field_values"."raw_text" is not null;
--> statement-breakpoint
CREATE INDEX "customer_custom_field_definition" ON "customer_version_custom_fields" USING btree ("organization_id","field_id","customer_id","revision");
--> statement-breakpoint
CREATE INDEX "customer_scheme_order" ON "customers" USING btree ("organization_id","created_at","updated_at","id") WHERE not "customers"."retired";
--> statement-breakpoint
CREATE UNIQUE INDEX "customers_available_code_key" ON "customers" USING btree ("organization_id",lower("code")) WHERE not "customers"."retired";
DROP INDEX "customers_code_key";
ALTER INDEX "customers_available_code_key" RENAME TO "customers_code_key";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customer_master_values" CHECK ("customers"."total_balance" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "customers"."igst_percent" between 0 and 100 and "customers"."sgst_percent" between 0 and 100
    and "customers"."cgst_percent" between 0 and 100 and "customers"."discount_percent" between 0 and 100
    and (not "customers"."retired" or not "customers"."active") and "customers"."custom_field_count" between 0 and 500
    and (("customers"."save_request_id" is null and "customers"."save_source" is null) or ("customers"."save_request_id" is not null and "customers"."save_source" is not null and "customers"."save_source" in ('master','registration'))));

-- Native Customer commands own every head/relationship write and its history.
-- Existing owner/import records keep their actual provenance; no backfill actors.
CREATE FUNCTION masters_guard_customer_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.customer_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Customer history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='customer_versions' THEN
    IF NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.saved_at IS DISTINCT FROM transaction_timestamp()
      OR NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NEW.organization_id IS DISTINCT FROM public.organization_module_scope()
      OR NOT EXISTS (SELECT 1 FROM public.customers customer WHERE customer.organization_id=NEW.organization_id AND customer.id=NEW.customer_id
        AND customer.revision=NEW.revision AND customer.save_request_id=NEW.request_id AND customer.save_source=NEW.save_source) THEN
      RAISE EXCEPTION 'Customer history requires its actual saved command' USING ERRCODE='23514',CONSTRAINT='customer_history_transaction';
    END IF;
  ELSE
    SELECT * INTO version FROM public.customer_versions WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision;
    IF version.customer_id IS NULL OR version.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
      RAISE EXCEPTION 'Customer relationships require their actual save transaction' USING ERRCODE='23514',CONSTRAINT='customer_history_transaction';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['customer_versions','customer_version_addresses','customer_version_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY customer_history_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT masters_can_read_party(''customer'')))',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER customer_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_customer_history()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_record_customer(target_customer uuid,previous_revision integer,operation text,request_fingerprint text,
  address_ids uuid[],contact_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; saved_revision integer;
BEGIN
  INSERT INTO public.customer_versions(organization_id,customer_id,revision,request_id,request_fingerprint,previous_revision,operation,
    code,name,legal_name,abbreviation,tax_identifier,credit_days,total_balance,default_invoice_notes,feedback_applicable,
    igst_percent,sgst_percent,cgst_percent,discount_percent,is_kaleen_bandhu,active,retired,save_source,custom_field_count,custom_fields_provided,
    address_count,contact_count,saved_by)
    SELECT organization_id,id,revision,save_request_id,request_fingerprint,previous_revision,operation,
      code,name,legal_name,abbreviation,tax_identifier,credit_days,total_balance,default_invoice_notes,feedback_applicable,
      igst_percent,sgst_percent,cgst_percent,discount_percent,is_kaleen_bandhu,active,retired,save_source,custom_field_count,custom_fields_provided,
      cardinality(address_ids),cardinality(contact_ids),actor FROM public.customers WHERE organization_id=org AND id=target_customer
    RETURNING revision INTO saved_revision;
  IF saved_revision IS NULL THEN RAISE EXCEPTION 'Customer was not found' USING ERRCODE='P0002',CONSTRAINT='customer_not_found'; END IF;
  INSERT INTO public.customer_version_addresses(organization_id,customer_id,revision,id,position,address_type,attention_to,line_1,line_2,city,state,
    postal_code,country_code,freeform_address,is_default)
    SELECT address.organization_id,address.customer_id,saved_revision,address.id,ordered.position-1,address.address_type,address.attention_to,
      address.line_1,address.line_2,address.city,address.state,address.postal_code,address.country_code,address.freeform_address,address.is_default
    FROM unnest(address_ids) WITH ORDINALITY ordered(id,position) JOIN public.customer_addresses address
      ON address.organization_id=org AND address.customer_id=target_customer AND address.id=ordered.id;
  INSERT INTO public.customer_version_contacts(organization_id,customer_id,revision,id,position,name,email,phone,designation,is_primary)
    SELECT contact.organization_id,contact.customer_id,saved_revision,contact.id,ordered.position-1,contact.name,contact.email,contact.phone,contact.designation,contact.is_primary
    FROM unnest(contact_ids) WITH ORDINALITY ordered(id,position) JOIN public.customer_contacts contact
      ON contact.organization_id=org AND contact.customer_id=target_customer AND contact.id=ordered.id;
  RETURN saved_revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_check_customer_relations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE address_count integer; contact_count integer;
BEGIN
  SELECT count(*) INTO address_count FROM public.customer_version_addresses WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision;
  SELECT count(*) INTO contact_count FROM public.customer_version_contacts WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision;
  IF address_count<>NEW.address_count OR contact_count<>NEW.contact_count
    OR EXISTS (SELECT 1 FROM public.customer_version_addresses WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision AND position>=address_count)
    OR EXISTS (SELECT 1 FROM public.customer_version_contacts WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision AND position>=contact_count) THEN
    RAISE EXCEPTION 'Customer relationships require a complete ordered snapshot' USING ERRCODE='23514',CONSTRAINT='customer_relations_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER customer_relations_complete AFTER INSERT ON customer_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_customer_relations();
--> statement-breakpoint
CREATE FUNCTION masters_customer_prior_request(target_customer uuid,expected_revision integer,request_id uuid,request_fingerprint text,requested_operation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior public.customer_versions;
BEGIN
  PERFORM public.masters_require_customer_write();
  IF target_customer IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR request_id IS NULL
    OR request_fingerprint IS NULL OR request_fingerprint !~ '^[a-f0-9]{64}$' OR requested_operation IS NULL
    OR requested_operation NOT IN ('create','update','retire') THEN
    RAISE EXCEPTION 'Invalid Customer command' USING ERRCODE='23514',CONSTRAINT='customer_command_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-save:'||org::text||':'||request_id::text,0));
  SELECT * INTO prior FROM public.customer_versions version WHERE version.organization_id=org AND version.request_id=masters_customer_prior_request.request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.customer_id IS DISTINCT FROM target_customer OR coalesce(prior.previous_revision,0) IS DISTINCT FROM expected_revision
    OR prior.operation IS DISTINCT FROM requested_operation OR prior.request_fingerprint IS DISTINCT FROM request_fingerprint
    OR prior.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Customer request was already used for another change' USING ERRCODE='23514',CONSTRAINT='customer_request_reused';
  END IF;
  RETURN prior.revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_save_customer(target_customer uuid,expected_revision integer,request_id uuid,request_fingerprint text,
  code text,name text,legal_name text,abbreviation text,tax_identifier text,credit_days integer,total_balance numeric,default_invoice_notes text,feedback_applicable boolean,
  igst_percent numeric,sgst_percent numeric,cgst_percent numeric,discount_percent numeric,is_kaleen_bandhu boolean,active boolean,custom_field_count integer,custom_fields_provided boolean,
  address_ids uuid[],address_types text[],attention_tos text[],line_1s text[],line_2s text[],cities text[],states text[],postal_codes text[],country_codes text[],freeform_addresses text[],address_defaults boolean[],
  contact_ids uuid[],contact_names text[],contact_emails text[],contact_phones text[],contact_designations text[],contact_primaries boolean[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); current_customer public.customers; prior integer;
  address_count integer:=cardinality(address_ids); contact_count integer:=cardinality(contact_ids);
BEGIN
  prior:=public.masters_customer_prior_request(target_customer,expected_revision,request_id,request_fingerprint,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO current_customer FROM public.customers WHERE organization_id=org AND id=target_customer FOR UPDATE;
  IF expected_revision>0 AND (current_customer.id IS NULL OR current_customer.retired) THEN
    RAISE EXCEPTION 'Customer was not found' USING ERRCODE='P0002',CONSTRAINT='customer_not_found';
  END IF;
  IF coalesce(current_customer.revision,0)<>expected_revision THEN
    RAISE EXCEPTION 'Customer changed; reload before saving' USING ERRCODE='40001',CONSTRAINT='customer_stale_revision';
  END IF;
  IF NOT coalesce(length(trim(code)) BETWEEN 1 AND 64 AND length(trim(name)) BETWEEN 1 AND 250 AND length(trim(legal_name)) BETWEEN 1 AND 250
    AND (abbreviation IS NULL OR length(abbreviation)<=64) AND (tax_identifier IS NULL OR length(tax_identifier)<=100)
    AND credit_days BETWEEN 0 AND 3650 AND total_balance NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
    AND (default_invoice_notes IS NULL OR length(default_invoice_notes)<=10000) AND igst_percent BETWEEN 0 AND 100 AND sgst_percent BETWEEN 0 AND 100
    AND cgst_percent BETWEEN 0 AND 100 AND discount_percent BETWEEN 0 AND 100 AND feedback_applicable IS NOT NULL AND is_kaleen_bandhu IS NOT NULL AND active IS NOT NULL
    AND custom_field_count BETWEEN 0 AND 500 AND custom_fields_provided IS NOT NULL,false) THEN
    RAISE EXCEPTION 'Invalid Customer details' USING ERRCODE='23514',CONSTRAINT='customer_command_input';
  END IF;
  IF NOT coalesce(address_count BETWEEN 0 AND 100 AND contact_count BETWEEN 0 AND 100
    AND cardinality(address_types)=address_count AND cardinality(attention_tos)=address_count AND cardinality(line_1s)=address_count AND cardinality(line_2s)=address_count
    AND cardinality(cities)=address_count AND cardinality(states)=address_count AND cardinality(postal_codes)=address_count AND cardinality(country_codes)=address_count
    AND cardinality(freeform_addresses)=address_count AND cardinality(address_defaults)=address_count AND cardinality(contact_names)=contact_count
    AND cardinality(contact_emails)=contact_count AND cardinality(contact_phones)=contact_count AND cardinality(contact_designations)=contact_count AND cardinality(contact_primaries)=contact_count,false)
    OR (SELECT count(DISTINCT id) FROM unnest(address_ids) ids(id))<>address_count OR (SELECT count(DISTINCT id) FROM unnest(contact_ids) ids(id))<>contact_count THEN
    RAISE EXCEPTION 'Invalid Customer relationships' USING ERRCODE='23514',CONSTRAINT='customer_relation_input';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_addresses WHERE organization_id=org AND id=ANY(address_ids) AND customer_id<>target_customer)
    OR EXISTS (SELECT 1 FROM public.customer_contacts WHERE organization_id=org AND id=ANY(contact_ids) AND customer_id<>target_customer)
    OR EXISTS (SELECT 1 FROM public.customer_version_addresses WHERE organization_id=org AND id=ANY(address_ids) AND customer_id<>target_customer)
    OR EXISTS (SELECT 1 FROM public.customer_version_contacts WHERE organization_id=org AND id=ANY(contact_ids) AND customer_id<>target_customer) THEN
    RAISE EXCEPTION 'Customer relationships cannot be reassigned' USING ERRCODE='23514',CONSTRAINT='customer_relation_owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(address_ids,address_types,attention_tos,line_1s,line_2s,cities,states,postal_codes,country_codes,freeform_addresses,address_defaults)
      incoming(id,address_type,attention_to,line_1,line_2,city,state,postal_code,country_code,freeform_address,is_default)
    LEFT JOIN public.customer_addresses stored ON stored.organization_id=org AND stored.customer_id=target_customer AND stored.id=incoming.id
    WHERE (stored.id IS NULL OR (incoming.address_type,incoming.attention_to,incoming.line_1,incoming.line_2,incoming.city,incoming.state,incoming.postal_code,incoming.country_code,incoming.freeform_address)
      IS DISTINCT FROM (stored.address_type,stored.attention_to,stored.line_1,stored.line_2,stored.city,stored.state,stored.postal_code,stored.country_code,stored.freeform_address))
    AND NOT coalesce(incoming.address_type IN ('billing','shipping','registered','other') AND incoming.is_default IS NOT NULL
      AND ((incoming.freeform_address IS NOT NULL AND length(trim(incoming.freeform_address)) BETWEEN 1 AND 4000
        AND num_nonnulls(incoming.attention_to,incoming.line_1,incoming.line_2,incoming.city,incoming.state,incoming.postal_code,incoming.country_code)=0)
      OR (incoming.freeform_address IS NULL AND length(trim(incoming.line_1)) BETWEEN 1 AND 250 AND length(trim(incoming.city)) BETWEEN 1 AND 120
        AND incoming.country_code ~ '^[A-Z]{2}$' AND (incoming.attention_to IS NULL OR length(incoming.attention_to)<=200)
        AND (incoming.line_2 IS NULL OR length(incoming.line_2)<=250) AND (incoming.state IS NULL OR length(incoming.state)<=120)
        AND (incoming.postal_code IS NULL OR length(incoming.postal_code)<=30))),false)
  ) OR EXISTS (
    SELECT 1 FROM unnest(contact_ids,contact_names,contact_emails,contact_phones,contact_designations,contact_primaries) incoming(id,name,email,phone,designation,is_primary)
    LEFT JOIN public.customer_contacts stored ON stored.organization_id=org AND stored.customer_id=target_customer AND stored.id=incoming.id
    WHERE (stored.id IS NULL OR (incoming.name,incoming.email,incoming.phone,incoming.designation) IS DISTINCT FROM (stored.name,stored.email,stored.phone,stored.designation))
    AND NOT coalesce(length(trim(incoming.name)) BETWEEN 1 AND 200 AND incoming.is_primary IS NOT NULL
      AND (incoming.email IS NULL OR (length(incoming.email)<=320 AND incoming.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
      AND (incoming.phone IS NULL OR length(trim(incoming.phone)) BETWEEN 1 AND 50) AND (incoming.designation IS NULL OR length(incoming.designation)<=120)
      AND num_nonnulls(incoming.email,incoming.phone)>0,false)
  ) THEN RAISE EXCEPTION 'Invalid Customer contact or address values' USING ERRCODE='23514',CONSTRAINT='customer_relation_input'; END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.customers(organization_id,id,code,name,legal_name,abbreviation,tax_identifier,credit_days,total_balance,default_invoice_notes,feedback_applicable,
      igst_percent,sgst_percent,cgst_percent,discount_percent,is_kaleen_bandhu,active,save_request_id,save_source,custom_field_count,custom_fields_provided)
      VALUES(org,target_customer,code,name,legal_name,abbreviation,tax_identifier,credit_days,total_balance,default_invoice_notes,feedback_applicable,
        igst_percent,sgst_percent,cgst_percent,discount_percent,is_kaleen_bandhu,active,request_id,'master',custom_field_count,custom_fields_provided);
  ELSE
    UPDATE public.customers customer SET code=masters_save_customer.code,name=masters_save_customer.name,legal_name=masters_save_customer.legal_name,
      abbreviation=masters_save_customer.abbreviation,tax_identifier=masters_save_customer.tax_identifier,credit_days=masters_save_customer.credit_days,
      total_balance=masters_save_customer.total_balance,default_invoice_notes=masters_save_customer.default_invoice_notes,feedback_applicable=masters_save_customer.feedback_applicable,
      igst_percent=masters_save_customer.igst_percent,sgst_percent=masters_save_customer.sgst_percent,cgst_percent=masters_save_customer.cgst_percent,
      discount_percent=masters_save_customer.discount_percent,is_kaleen_bandhu=masters_save_customer.is_kaleen_bandhu,active=masters_save_customer.active,
      save_request_id=request_id,save_source='master',custom_field_count=masters_save_customer.custom_field_count,custom_fields_provided=masters_save_customer.custom_fields_provided,
      revision=customer.revision+1,updated_at=transaction_timestamp() WHERE customer.organization_id=org AND customer.id=target_customer;
  END IF;
  -- Same-ID rows are updated in place. Clear old default flags before applying
  -- the complete set, so switching the default never transiently duplicates it.
  DELETE FROM public.customer_addresses WHERE organization_id=org AND customer_id=target_customer AND NOT(id=ANY(address_ids));
  DELETE FROM public.customer_contacts WHERE organization_id=org AND customer_id=target_customer AND NOT(id=ANY(contact_ids));
  UPDATE public.customer_addresses SET is_default=false WHERE organization_id=org AND customer_id=target_customer AND is_default;
  UPDATE public.customer_contacts SET is_primary=false WHERE organization_id=org AND customer_id=target_customer AND is_primary;
  INSERT INTO public.customer_addresses(organization_id,customer_id,id,address_type,attention_to,line_1,line_2,city,state,postal_code,country_code,freeform_address,is_default)
    SELECT org,target_customer,* FROM unnest(address_ids,address_types,attention_tos,line_1s,line_2s,cities,states,postal_codes,country_codes,freeform_addresses,address_defaults)
    ON CONFLICT(organization_id,id) DO UPDATE SET address_type=excluded.address_type,attention_to=excluded.attention_to,line_1=excluded.line_1,line_2=excluded.line_2,
      city=excluded.city,state=excluded.state,postal_code=excluded.postal_code,country_code=excluded.country_code,freeform_address=excluded.freeform_address,is_default=excluded.is_default
    WHERE customer_addresses.customer_id=target_customer;
  INSERT INTO public.customer_contacts(organization_id,customer_id,id,name,email,phone,designation,is_primary)
    SELECT org,target_customer,* FROM unnest(contact_ids,contact_names,contact_emails,contact_phones,contact_designations,contact_primaries)
    ON CONFLICT(organization_id,id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,designation=excluded.designation,is_primary=excluded.is_primary
    WHERE customer_contacts.customer_id=target_customer;
  RETURN public.masters_record_customer(target_customer,nullif(expected_revision,0),CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END,request_fingerprint,address_ids,contact_ids);
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_retire_customer(target_customer uuid,expected_revision integer,request_id uuid,request_fingerprint text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); current_customer public.customers; prior integer; address_ids uuid[]; contact_ids uuid[];
BEGIN
  prior:=public.masters_customer_prior_request(target_customer,expected_revision,request_id,request_fingerprint,'retire');
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO current_customer FROM public.customers WHERE organization_id=org AND id=target_customer FOR UPDATE;
  IF current_customer.id IS NULL OR current_customer.retired THEN RAISE EXCEPTION 'Customer was not found' USING ERRCODE='P0002',CONSTRAINT='customer_not_found'; END IF;
  IF current_customer.revision<>expected_revision THEN RAISE EXCEPTION 'Customer changed; reload before deleting' USING ERRCODE='40001',CONSTRAINT='customer_stale_revision'; END IF;
  IF EXISTS(SELECT 1 FROM public.samples WHERE organization_id=org AND customer_id=target_customer)
    OR EXISTS(SELECT 1 FROM public.customer_quotations WHERE organization_id=org AND customer_id=target_customer) THEN
    RAISE EXCEPTION 'Customer is in use' USING ERRCODE='23503',CONSTRAINT='customer_in_use';
  END IF;
  SELECT coalesce(array_agg(address.id ORDER BY saved.position NULLS LAST,address.id),'{}') INTO address_ids FROM public.customer_addresses address
    LEFT JOIN public.customer_version_addresses saved ON saved.organization_id=address.organization_id AND saved.customer_id=address.customer_id
      AND saved.id=address.id AND saved.revision=current_customer.revision WHERE address.organization_id=org AND address.customer_id=target_customer;
  SELECT coalesce(array_agg(contact.id ORDER BY saved.position NULLS LAST,contact.id),'{}') INTO contact_ids FROM public.customer_contacts contact
    LEFT JOIN public.customer_version_contacts saved ON saved.organization_id=contact.organization_id AND saved.customer_id=contact.customer_id
      AND saved.id=contact.id AND saved.revision=current_customer.revision WHERE contact.organization_id=org AND contact.customer_id=target_customer;
  UPDATE public.customers SET retired=true,active=false,revision=revision+1,save_request_id=request_id,save_source='master',custom_fields_provided=false,
    updated_at=transaction_timestamp() WHERE organization_id=org AND id=target_customer;
  RETURN public.masters_record_customer(target_customer,expected_revision,'retire',request_fingerprint,address_ids,contact_ids);
END $$;
--> statement-breakpoint
REVOKE INSERT,UPDATE,DELETE ON customers,customer_addresses,customer_contacts FROM sampleify_app;
DO $$ DECLARE routine regprocedure; BEGIN
  FOR routine IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname=ANY(ARRAY['masters_guard_customer_history','masters_record_customer','masters_check_customer_relations','masters_customer_prior_request','masters_save_customer','masters_retire_customer']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,sampleify_app,sampleify_report_worker',routine);
  END LOOP;
  FOR routine IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname=ANY(ARRAY['masters_customer_prior_request','masters_save_customer','masters_retire_customer']) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sampleify_app',routine);
  END LOOP;
END $$;

--> statement-breakpoint
CREATE FUNCTION masters_assert_customer_custom_fields(target_organization uuid,target_customer uuid,target_revision integer,check_definition_set boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.customer_versions; field_count integer; minimum_position integer; maximum_position integer; item_count integer;
BEGIN
  SELECT * INTO version FROM public.customer_versions
    WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer Custom Field history is missing' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_complete'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(value_count),0) INTO field_count,minimum_position,maximum_position,item_count
    FROM public.customer_version_custom_fields
    WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision;
  IF field_count<>version.custom_field_count OR item_count>5000
    OR (field_count>0 AND (minimum_position<>0 OR maximum_position<>field_count-1)) THEN
    RAISE EXCEPTION 'Customer Custom Fields require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_complete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_version_custom_fields field LEFT JOIN LATERAL (
      SELECT count(*) AS count,min(position) AS minimum,max(position) AS maximum
      FROM public.customer_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.customer_id=field.customer_id
        AND value.revision=field.revision AND value.field_id=field.field_id
    ) items ON true
    WHERE field.organization_id=target_organization AND field.customer_id=target_customer AND field.revision=target_revision
      AND (items.count<>field.value_count OR (items.count>0 AND (items.minimum<>0 OR items.maximum<>items.count-1)))
  ) THEN RAISE EXCEPTION 'Customer Custom Field items require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_complete'; END IF;
  IF version.custom_fields_provided THEN
    IF check_definition_set AND (EXISTS (
      SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='customer'
      EXCEPT SELECT field_id,field_revision FROM public.customer_version_custom_fields
        WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision
    ) OR EXISTS (
      SELECT field_id,field_revision FROM public.customer_version_custom_fields
        WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision
      EXCEPT SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='customer'
    )) THEN RAISE EXCEPTION 'Customer Custom Field definitions changed' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_definition_set'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.customer_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      WHERE field.organization_id=target_organization AND field.customer_id=target_customer AND field.revision=target_revision AND definition.is_required
      AND NOT (
        (field.is_array AND definition.field_type<>'multi_user_select'
          AND (NOT definition.allows_multiple OR definition.field_type='attachment'))
        OR EXISTS (
        SELECT 1 FROM public.customer_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.customer_id=field.customer_id AND value.revision=field.revision AND value.field_id=field.field_id
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
    ) THEN RAISE EXCEPTION 'A required Customer Custom Field is empty' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_required'; END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_customer_custom_field_uniqueness(target_organization uuid,target_customer uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.customer_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=target_organization AND field.customer_id=target_customer AND field.revision=target_revision
      AND definition.validate_uniqueness
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.customer_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.customer_version_custom_field_values value ON value.organization_id=field.organization_id AND value.customer_id=field.customer_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.customer_id=target_customer AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.customer_version_custom_field_values value ON value.organization_id=field.organization_id AND value.customer_id=field.customer_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.customer_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.customers customer ON customer.organization_id=existing.organization_id AND customer.id=existing.customer_id AND customer.revision=existing.revision AND NOT customer.retired
    WHERE field.organization_id=target_organization AND field.customer_id=target_customer AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.customer_id<>target_customer
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_customer_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer;
BEGIN
  IF NEW.save_source IS NULL AND session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF NEW.save_source='registration' THEN
    PERFORM public.organization_require_module_access('customer');
    IF TG_OP<>'INSERT' OR NOT public.app_has_permission('samples.create') OR NEW.custom_fields_provided OR NEW.custom_field_count<>0 THEN
      RAISE EXCEPTION 'Registration fields require the native quick-create command' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM public.masters_require_customer_write();
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() THEN
    RAISE EXCEPTION 'Customer fields require the authenticated organization' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.customer_versions WHERE organization_id=OLD.organization_id AND customer_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_customer_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF NEW.retired AND NEW.custom_fields_provided THEN
    RAISE EXCEPTION 'Customer retirement preserves Custom Fields' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_preserve';
  END IF;
  IF NEW.custom_fields_provided THEN
    SELECT count(*) INTO expected_count FROM public.custom_field_definitions
      WHERE organization_id=NEW.organization_id AND associated_with='customer' AND active;
    IF expected_count<>NEW.custom_field_count THEN
      RAISE EXCEPTION 'Provide the current Customer Custom Fields' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_definition_set';
    END IF;
  ELSE
    expected_count := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.custom_field_count END;
    IF NEW.custom_field_count<>expected_count OR (NOT NEW.retired AND EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND associated_with='customer' AND active
    )) THEN RAISE EXCEPTION 'Customer Custom Field omission requires no current definitions' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_preserve'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_custom_field_change BEFORE INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION masters_guard_customer_custom_field_change();
--> statement-breakpoint
CREATE FUNCTION masters_initialize_customer_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE customer public.customers;
BEGIN
  SELECT * INTO customer FROM public.customers WHERE organization_id=NEW.organization_id AND id=NEW.customer_id AND revision=NEW.revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer field history requires its actual Customer revision' USING ERRCODE='23514'; END IF;
  NEW.custom_field_count := customer.custom_field_count;
  NEW.custom_fields_provided := customer.custom_fields_provided;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_custom_field_metadata BEFORE INSERT ON customer_versions FOR EACH ROW EXECUTE FUNCTION masters_initialize_customer_custom_field_metadata();
--> statement-breakpoint
CREATE FUNCTION masters_guard_customer_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.customer_versions; field public.customer_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Customer Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.customer_versions WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision;
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR version.customer_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.customers WHERE organization_id=NEW.organization_id AND id=NEW.customer_id
        AND revision=NEW.revision AND save_request_id=version.request_id)) THEN
    RAISE EXCEPTION 'Customer Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='customer_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Customer Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Customer Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='customer' AND active
    ) THEN RAISE EXCEPTION 'Select the current Customer Custom Field revision' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.customer_version_custom_fields
      WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Customer Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Customer Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.customer_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.customer_id=NEW.customer_id
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
          SELECT field_id FROM public.customer_version_custom_fields
            WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=version.previous_revision
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
            SELECT field_id FROM public.customer_version_custom_fields
              WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=version.previous_revision
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.customer_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.customer_id=NEW.customer_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Customer revision' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with='customer' AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.customer_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.customer_id=NEW.customer_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_attachment'; END IF;
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
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_lookup'; END IF;
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
        SELECT 1 FROM public.customer_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.customer_id=NEW.customer_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.customer_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.customer_id=NEW.customer_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='customer_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['customer_version_custom_fields','customer_version_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY customer_custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope())
        AND (SELECT masters_can_read_party(''customer'')))',relation);
    EXECUTE format('CREATE POLICY customer_custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT masters_require_customer_write()))',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_report_worker',relation);
    EXECUTE format('CREATE TRIGGER customer_custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_customer_custom_field_history()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_customer_custom_field_preservation(target_organization uuid,target_customer uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.customer_versions;
BEGIN
  SELECT * INTO version FROM public.customer_versions WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","customer_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.customer_version_custom_fields WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision EXCEPT SELECT "organization_id","customer_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.customer_version_custom_fields WHERE organization_id=target_organization AND customer_id=target_customer AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","customer_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.customer_version_custom_fields WHERE organization_id=target_organization AND customer_id=target_customer AND revision=version.previous_revision EXCEPT SELECT "organization_id","customer_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.customer_version_custom_fields WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision) OR EXISTS (SELECT "organization_id","customer_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.customer_version_custom_field_values WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision EXCEPT SELECT "organization_id","customer_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.customer_version_custom_field_values WHERE organization_id=target_organization AND customer_id=target_customer AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","customer_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.customer_version_custom_field_values WHERE organization_id=target_organization AND customer_id=target_customer AND revision=version.previous_revision EXCEPT SELECT "organization_id","customer_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.customer_version_custom_field_values WHERE organization_id=target_organization AND customer_id=target_customer AND revision=target_revision) THEN
    RAISE EXCEPTION 'Customer Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='customer_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_preserve_customer_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.customer_version_custom_fields("organization_id","customer_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","customer_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.customer_version_custom_fields
    WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.previous_revision;
  INSERT INTO public.customer_version_custom_field_values("organization_id","customer_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id")
    SELECT "organization_id","customer_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.customer_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_check_customer_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_customer_custom_fields(NEW.organization_id,NEW.customer_id,NEW.revision,true);
  PERFORM public.masters_assert_customer_custom_field_preservation(NEW.organization_id,NEW.customer_id,NEW.revision);
  IF NEW.custom_fields_provided THEN PERFORM public.masters_assert_customer_custom_field_uniqueness(NEW.organization_id,NEW.customer_id,NEW.revision); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER customer_custom_fields_preserve AFTER INSERT ON customer_versions FOR EACH ROW EXECUTE FUNCTION masters_preserve_customer_custom_fields();
CREATE CONSTRAINT TRIGGER customer_custom_fields_complete AFTER INSERT ON customer_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_customer_custom_fields();
REVOKE ALL ON FUNCTION masters_assert_customer_custom_fields(uuid,uuid,integer,boolean),masters_guard_customer_custom_field_change(),
  masters_initialize_customer_custom_field_metadata(),masters_guard_customer_custom_field_history(),masters_assert_customer_custom_field_uniqueness(uuid,uuid,integer),
  masters_assert_customer_custom_field_preservation(uuid,uuid,integer),masters_preserve_customer_custom_fields(),masters_check_customer_custom_fields()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_quick_customer(display_name text, legal_name text, contact_name text, contact_email text,
  contact_phone text, billing_address text, shipping_address text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  created_customer_id uuid := gen_random_uuid(); customer_code text;
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
  INSERT INTO public.customers(organization_id, id, code, name, legal_name, credit_days,save_request_id,save_source)
    VALUES (org, created_customer_id, customer_code, trim(display_name), trim(legal_name), 30,gen_random_uuid(),'registration');
  INSERT INTO public.customer_contacts(organization_id, customer_id, name, email, phone, is_primary)
    VALUES (org, created_customer_id, trim(contact_name), trim(contact_email), trim(contact_phone), true);
  INSERT INTO public.customer_addresses(organization_id, customer_id, address_type, freeform_address, is_default)
    VALUES (org, created_customer_id, 'billing', trim(billing_address), true), (org, created_customer_id, 'shipping', trim(shipping_address), true);
  PERFORM public.masters_record_customer(created_customer_id,NULL,'create',NULL,
    ARRAY(SELECT address.id FROM public.customer_addresses address WHERE address.organization_id=org AND address.customer_id=created_customer_id ORDER BY address.id),
    ARRAY(SELECT contact.id FROM public.customer_contacts contact WHERE contact.organization_id=org AND contact.customer_id=created_customer_id ORDER BY contact.id));
  RETURN created_customer_id;
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
    OR definition.associated_with NOT IN ('product','parameter','method_of_analysis','users','customer') OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires a current active supported field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  IF definition.associated_with='customer' THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'Customer attachments require their upload command' USING ERRCODE='42501'; END IF;
    PERFORM public.masters_require_customer_write();
    IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope()
      OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'Customer attachments require the actual organization, editor and transaction' USING ERRCODE='42501';
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
-- Customer attachments share the typed byte store, but require configured
-- Customer access for reads and their native upload command for writes.
ALTER POLICY custom_field_attachment_read ON custom_field_attachments USING (
  organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope())
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage'))
  AND EXISTS (SELECT 1 FROM custom_field_versions definition
    WHERE definition.organization_id=custom_field_attachments.organization_id AND definition.field_id=custom_field_attachments.field_id
      AND definition.revision=custom_field_attachments.field_revision AND definition.field_type='attachment'
      AND (definition.associated_with IN ('product','parameter','method_of_analysis')
        OR definition.associated_with='customer' AND (SELECT masters_can_read_party('customer'))))
);
--> statement-breakpoint
CREATE FUNCTION masters_upload_customer_attachment(target_id uuid,target_field uuid,target_revision integer,file_name text,file_type text,file_content bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid; prior public.custom_field_attachments; definition public.custom_field_definitions;
BEGIN
  PERFORM public.masters_require_customer_write();
  actor:=nullif(current_setting('app.user_id',true),'')::uuid;
  IF target_id IS NULL OR target_field IS NULL OR target_revision IS NULL OR target_revision<1 OR file_content IS NULL OR octet_length(file_content)>20971520 THEN
    RAISE EXCEPTION 'Invalid Customer attachment' USING ERRCODE='23514',CONSTRAINT='customer_attachment_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||org::text||':'||target_id::text,0));
  SELECT * INTO prior FROM public.custom_field_attachments WHERE organization_id=org AND id=target_id;
  IF FOUND THEN
    IF (prior.field_id,prior.field_revision,prior.original_name,prior.media_type,prior.content,prior.uploaded_by)
      IS DISTINCT FROM (target_field,target_revision,file_name,file_type,file_content,actor)
      OR NOT EXISTS (SELECT 1 FROM public.custom_field_versions WHERE organization_id=org AND field_id=prior.field_id AND revision=prior.field_revision AND associated_with='customer') THEN
      RAISE EXCEPTION 'Attachment request already used' USING ERRCODE='23514',CONSTRAINT='customer_attachment_request_reused';
    END IF;
    RETURN true;
  END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=org AND id=target_field;
  IF definition.id IS NULL OR NOT definition.active OR definition.associated_with<>'customer' OR definition.field_type<>'attachment' THEN
    RAISE EXCEPTION 'Customer attachment field was not found' USING ERRCODE='P0002',CONSTRAINT='customer_attachment_field_not_found';
  END IF;
  IF definition.revision<>target_revision THEN RAISE EXCEPTION 'Custom Field changed' USING ERRCODE='23514',CONSTRAINT='customer_attachment_field_changed'; END IF;
  INSERT INTO public.custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,target_id,target_field,target_revision,file_name,file_type,file_content,octet_length(file_content),encode(sha256(file_content),'hex'),actor);
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION masters_upload_customer_attachment(uuid,uuid,integer,text,text,bytea) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_upload_customer_attachment(uuid,uuid,integer,text,text,bytea) TO sampleify_app;

--> statement-breakpoint
CREATE FUNCTION masters_customer_scheme_context(include_customers boolean,include_samples boolean)
RETURNS TABLE("currentYearDigits" text,"nextYearDigits" text,separator text,"currentMonthFormat" text,"nonNablStartNumber" text,
  "customerCount" double precision,"sampleCount" double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('masters.manage') OR NOT public.organization_has_module_access('customer') THEN
    RAISE EXCEPTION 'Customer scheme generation requires permission' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.scheme_current_year_digits,settings.scheme_next_year_digits,settings.scheme_separator,
    settings.scheme_month_format,settings.scheme_non_nabl_start_number,
    CASE WHEN include_customers THEN (SELECT count(*)::double precision FROM public.customers customer WHERE customer.organization_id=org AND NOT customer.retired) ELSE 0::double precision END,
    CASE WHEN include_samples THEN (SELECT count(*)::double precision FROM public.samples sample WHERE sample.organization_id=org) ELSE 0::double precision END
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=org;
END $$;
REVOKE ALL ON FUNCTION masters_customer_scheme_context(boolean,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_customer_scheme_context(boolean,boolean) TO sampleify_app;
