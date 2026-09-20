CREATE TABLE "organization_allocated_fields" (
	"organization_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	CONSTRAINT "organization_allocated_fields_organization_id_field_key_pk" PRIMARY KEY("organization_id","field_key"),
	CONSTRAINT "org_allocated_field_key" CHECK ("organization_allocated_fields"."field_key" in ('disciplines','customer','retained','generate_url','blind','product'))
);
--> statement-breakpoint
CREATE TABLE "organization_custom_table_roles" (
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "organization_custom_table_roles_organization_id_role_id_pk" PRIMARY KEY("organization_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "organization_document_settings" (
	"organization_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"number_scheme" text,
	"number_padding" integer,
	"header_template_id" uuid,
	"header_height_mm" integer,
	CONSTRAINT "organization_document_settings_organization_id_document_type_pk" PRIMARY KEY("organization_id","document_type"),
	CONSTRAINT "org_document_setting_type" CHECK ("organization_document_settings"."document_type" in ('proforma_invoice','quotation','label','sample_receipt','sample_request')),
	CONSTRAINT "org_document_setting_fields" CHECK (length("organization_document_settings"."number_scheme")<=200 and ("organization_document_settings"."number_padding" is null or "organization_document_settings"."number_padding" between 1 and 20)
    and ("organization_document_settings"."header_height_mm" is null or "organization_document_settings"."header_height_mm">0))
);
--> statement-breakpoint
CREATE TABLE "organization_logo_files" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_logo_files_organization_id_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "org_logo_media_type" CHECK ("organization_logo_files"."media_type" in ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "org_logo_size" CHECK ("organization_logo_files"."byte_length" between 1 and 2097152 and "organization_logo_files"."byte_length"=octet_length("organization_logo_files"."content"))
);
--> statement-breakpoint
CREATE TABLE "organization_project_tabs" (
	"organization_id" uuid NOT NULL,
	"tab_key" text NOT NULL,
	CONSTRAINT "organization_project_tabs_organization_id_tab_key_pk" PRIMARY KEY("organization_id","tab_key"),
	CONSTRAINT "org_project_tab_key" CHECK ("organization_project_tabs"."tab_key" in ('overview','stages','files','update_history','workflow','team','requests','planner','critical_params','project_metadata','project_rationale','activity_log'))
);
--> statement-breakpoint
CREATE TABLE "organization_reminder_emails" (
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "organization_reminder_emails_organization_id_email_pk" PRIMARY KEY("organization_id","email"),
	CONSTRAINT "org_reminder_email_format" CHECK ("organization_reminder_emails"."email" ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and "organization_reminder_emails"."email"=lower("organization_reminder_emails"."email") and length("organization_reminder_emails"."email")<=254)
);
--> statement-breakpoint
CREATE TABLE "organization_reminder_times" (
	"organization_id" uuid NOT NULL,
	"reminder_time" time NOT NULL,
	CONSTRAINT "organization_reminder_times_organization_id_reminder_time_pk" PRIMARY KEY("organization_id","reminder_time")
);
--> statement-breakpoint
CREATE TABLE "organization_sample_listing_fields" (
	"organization_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	CONSTRAINT "organization_sample_listing_fields_organization_id_field_key_pk" PRIMARY KEY("organization_id","field_key"),
	CONSTRAINT "org_sample_listing_field_key" CHECK ("organization_sample_listing_fields"."field_key" in ('customer','product','created_date','category','status','ulr_number'))
);
--> statement-breakpoint
CREATE TABLE "organization_template_defaults" (
	"organization_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"template_id" uuid NOT NULL,
	CONSTRAINT "organization_template_defaults_organization_id_purpose_pk" PRIMARY KEY("organization_id","purpose"),
	CONSTRAINT "org_template_default_purpose" CHECK ("organization_template_defaults"."purpose" in ('acknowledgement','result_page','ilc_report','comparative_report','intralab_report'))
);
--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "nabl_number" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "location_code" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "entity_name" text DEFAULT 'Sample' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "product_entity_name" text DEFAULT 'Product' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "header_style" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "template_acl_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "workflow_based_acl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "workflow_based_templates" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "zebra_printing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "scrollable_sample_listing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "auto_initialize_samples" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "show_barcode_section" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "show_jobcard_actions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "show_datasheet_actions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "show_workflow_nodes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "use_templatized_acknowledgement" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "directly_print_coa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "allow_manual_results" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "non_lims_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "lims_label" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "sample_association_mode" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "default_sample_category_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "sample_number_scheme" text DEFAULT 'SMP-{current_year:yyyy}-{sample_counter}' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "test_request_number_scheme" text DEFAULT 'TR-{current_year:yyyy}-{tr_counter}' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "job_number_scheme" text DEFAULT 'JOB-{current_year:yyyy}-{job_countall}' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "sample_number_start" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "test_request_number_start" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "instrument_breakdown_validation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "minimum_material_validation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "measurement_uncertainty_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "reminder_before_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "print_nabl_on_non_nabl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "on_demand_ulr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "generate_ulr_for_amendment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "ulr_start_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "include_f_in_ulr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "ulr_number_padding" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "retention_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "company_legal_name" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "company_identification_number" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "company_tax_identifier" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "company_address" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "default_retention_period" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "default_classification" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "product_label" text DEFAULT 'Product' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "sample_label" text DEFAULT 'Sample' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "customer_label" text DEFAULT 'Customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "vendor_label" text DEFAULT 'Vendor' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "sample_scheme" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "minimum_password_length" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "maximum_login_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "support_slug" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "operating_start_time" time;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "operating_end_time" time;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "environment_data_interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "project_default_page" text;--> statement-breakpoint
ALTER TABLE "organization_custom_table_roles" ADD CONSTRAINT "org_custom_table_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_document_settings" ADD CONSTRAINT "org_document_setting_header_fk" FOREIGN KEY ("organization_id","header_template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_logo_files" ADD CONSTRAINT "org_logo_actor_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_template_defaults" ADD CONSTRAINT "org_template_default_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_default_category_fk" FOREIGN KEY ("organization_id","default_sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_identity_fields" CHECK (length("organization_laboratory_settings"."display_name")<=200 and length("organization_laboratory_settings"."description")<=4000 and length("organization_laboratory_settings"."tagline")<=300
    and length("organization_laboratory_settings"."brand_color")<=20 and length("organization_laboratory_settings"."nabl_number")<=100 and length("organization_laboratory_settings"."location_code")<=64
    and length("organization_laboratory_settings"."entity_name") between 1 and 100 and length("organization_laboratory_settings"."product_entity_name") between 1 and 100
    and ("organization_laboratory_settings"."header_style" is null or "organization_laboratory_settings"."header_style" in ('fixed','floating')));--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_sample_page_fields" CHECK (("organization_laboratory_settings"."lims_label" is null or length("organization_laboratory_settings"."lims_label")<=100)
    and "organization_laboratory_settings"."sample_association_mode" in ('single','multiple'));--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_numbering_fields" CHECK (length("organization_laboratory_settings"."sample_number_scheme") between 1 and 200 and length("organization_laboratory_settings"."test_request_number_scheme") between 1 and 200
    and length("organization_laboratory_settings"."job_number_scheme") between 1 and 200 and "organization_laboratory_settings"."sample_number_start">0 and "organization_laboratory_settings"."test_request_number_start">0);--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_nabl_fields" CHECK ("organization_laboratory_settings"."ulr_start_number">0 and "organization_laboratory_settings"."ulr_number_padding" between 1 and 20 and "organization_laboratory_settings"."retention_days">=0);--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_accounting_fields" CHECK (length("organization_laboratory_settings"."company_legal_name")<=250 and length("organization_laboratory_settings"."company_identification_number")<=100
    and length("organization_laboratory_settings"."company_tax_identifier")<=100 and length("organization_laboratory_settings"."company_address")<=4000);--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_tenant_fields" CHECK ("organization_laboratory_settings"."default_retention_period">=0 and length("organization_laboratory_settings"."default_classification")<=150
    and length("organization_laboratory_settings"."product_label") between 1 and 100 and length("organization_laboratory_settings"."sample_label") between 1 and 100
    and length("organization_laboratory_settings"."customer_label") between 1 and 100 and length("organization_laboratory_settings"."vendor_label") between 1 and 100
    and length("organization_laboratory_settings"."sample_scheme")<=200 and "organization_laboratory_settings"."minimum_password_length" between 8 and 200 and "organization_laboratory_settings"."maximum_login_attempts" between 1 and 20
    and length("organization_laboratory_settings"."support_slug")<=100 and ("organization_laboratory_settings"."environment_data_interval_minutes" is null or "organization_laboratory_settings"."environment_data_interval_minutes">0)
    and ("organization_laboratory_settings"."operating_start_time" is null or "organization_laboratory_settings"."operating_end_time" is null or "organization_laboratory_settings"."operating_start_time"<>"organization_laboratory_settings"."operating_end_time")
    and ("organization_laboratory_settings"."project_default_page" is null or "organization_laboratory_settings"."project_default_page" in ('overview','stages','files','update_history','workflow','team','requests','planner','critical_params','project_metadata','project_rationale','activity_log')));
--> statement-breakpoint

-- New settings child tables hold current state only (no versioned snapshots, unlike
-- organization_instrument_service_entries/organization_module_access_modules), so they use plain
-- RLS read/write policies like the masters step-6 child tables, not the SECURITY DEFINER
-- writer-lock/version-snapshot machinery those two tables use for their own audit reasons.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['organization_reminder_times','organization_reminder_emails','organization_custom_table_roles',
    'organization_template_defaults','organization_document_settings','organization_allocated_fields',
    'organization_sample_listing_fields','organization_project_tabs','organization_logo_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY organization_settings_child_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''settings.read'') OR app_has_permission(''settings.manage'')))',relation);
    EXECUTE format('CREATE POLICY organization_settings_child_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''settings.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''settings.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;