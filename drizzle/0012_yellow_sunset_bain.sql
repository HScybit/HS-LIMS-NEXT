CREATE TABLE "customer_addresses" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_type" text NOT NULL,
	"attention_to" text,
	"line_1" text NOT NULL,
	"line_2" text,
	"city" text NOT NULL,
	"state" text,
	"postal_code" text,
	"country_code" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "customer_addresses_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "customer_address_type" CHECK ("customer_addresses"."address_type" in ('billing', 'shipping', 'registered', 'other') and length("customer_addresses"."country_code") = 2)
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"designation" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "customer_contacts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "customer_contact_details" CHECK (length(trim("customer_contacts"."name")) between 1 and 200 and (nullif(trim("customer_contacts"."email"), '') is not null or nullif(trim("customer_contacts"."phone"), '') is not null))
);
--> statement-breakpoint
CREATE TABLE "customer_quotations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"quotation_number" text NOT NULL,
	"quotation_date" date NOT NULL,
	"valid_until" date,
	"currency_code" text DEFAULT 'INR' NOT NULL,
	"total_amount" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_quotations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "customer_quotation_number_key" UNIQUE("organization_id","quotation_number"),
	CONSTRAINT "customer_quotation_owner_key" UNIQUE("organization_id","customer_id","id"),
	CONSTRAINT "customer_quotation_details" CHECK ("customer_quotations"."status" in ('draft', 'approved', 'expired', 'cancelled') and "customer_quotations"."total_amount" >= 0 and "customer_quotations"."total_amount" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and length("customer_quotations"."currency_code") = 3 and ("customer_quotations"."valid_until" is null or "customer_quotations"."valid_until" >= "customer_quotations"."quotation_date"))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legal_name" text NOT NULL,
	"abbreviation" text,
	"tax_identifier" text,
	"credit_days" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "customers_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "customers_metadata" CHECK (length(trim("customers"."code")) between 1 and 64 and length(trim("customers"."name")) between 1 and 250 and "customers"."revision" > 0),
	CONSTRAINT "customers_details" CHECK (length(trim("customers"."legal_name")) between 1 and 250 and "customers"."credit_days" between 0 and 3650)
);
--> statement-breakpoint
CREATE TABLE "decision_rule_limits" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"decision_rule_id" uuid NOT NULL,
	"lower_limit" numeric,
	"upper_limit" numeric,
	"lower_inclusive" boolean DEFAULT true NOT NULL,
	"upper_inclusive" boolean DEFAULT true NOT NULL,
	"outcome" text NOT NULL,
	"narration" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "decision_rule_limits_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "decision_rule_limit_bounds" CHECK (num_nonnulls("decision_rule_limits"."lower_limit", "decision_rule_limits"."upper_limit") >= 1 and "decision_rule_limits"."lower_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rule_limits"."upper_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and ("decision_rule_limits"."lower_limit" is null or "decision_rule_limits"."upper_limit" is null or "decision_rule_limits"."lower_limit" <= "decision_rule_limits"."upper_limit") and "decision_rule_limits"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "decision_rules" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"test_parameter_id" uuid NOT NULL,
	"method_id" uuid,
	"sample_category_id" uuid,
	"template_id" uuid,
	"cutoff_value" numeric DEFAULT '0' NOT NULL,
	"greater_than_text" text,
	"less_than_text" text,
	"minimum_text" text,
	"maximum_text" text,
	"unit_of_measure" text,
	"is_nabl" boolean DEFAULT false NOT NULL,
	"minimum_size" text,
	"estimated_time_in_days" numeric DEFAULT '0' NOT NULL,
	"estimated_charges" numeric DEFAULT '0' NOT NULL,
	"express_time_in_days" numeric DEFAULT '0' NOT NULL,
	"express_charges" numeric DEFAULT '0' NOT NULL,
	"result_representation" text,
	"default_narration" text,
	"detectable_upper_limit" numeric,
	"detectable_lower_limit" numeric,
	"detectable_upper_limit_text" text,
	"detectable_lower_limit_text" text,
	"show_detectable_limit_text" boolean DEFAULT false NOT NULL,
	"show_standard_limit_text" boolean DEFAULT false NOT NULL,
	"conformance_limit" numeric,
	"discipline" text,
	"rule_group" text,
	"unique_key" text,
	CONSTRAINT "decision_rules_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "decision_rule_scope_key" UNIQUE NULLS NOT DISTINCT("organization_id","product_id","test_parameter_id","method_id","sample_category_id"),
	CONSTRAINT "decision_rules_metadata" CHECK (length(trim("decision_rules"."code")) between 1 and 64 and length(trim("decision_rules"."name")) between 1 and 250 and "decision_rules"."revision" > 0),
	CONSTRAINT "decision_rule_finite_numbers" CHECK ("decision_rules"."cutoff_value" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rules"."detectable_upper_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rules"."detectable_lower_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rules"."conformance_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
	CONSTRAINT "decision_rule_estimates" CHECK ("decision_rules"."estimated_time_in_days" >= 0 and "decision_rules"."estimated_time_in_days" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rules"."estimated_charges" >= 0 and "decision_rules"."estimated_charges" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rules"."express_time_in_days" >= 0 and "decision_rules"."express_time_in_days" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "decision_rules"."express_charges" >= 0 and "decision_rules"."express_charges" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
--> statement-breakpoint
CREATE TABLE "laboratories" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "laboratories_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "laboratories_metadata" CHECK (length(trim("laboratories"."code")) between 1 and 64 and length(trim("laboratories"."name")) between 1 and 250 and "laboratories"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "measurement_units" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"symbol" text NOT NULL,
	"dimension" text,
	CONSTRAINT "measurement_units_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "measurement_units_metadata" CHECK (length(trim("measurement_units"."code")) between 1 and 64 and length(trim("measurement_units"."name")) between 1 and 250 and "measurement_units"."revision" > 0),
	CONSTRAINT "measurement_units_symbol" CHECK (length("measurement_units"."symbol") between 1 and 32)
);
--> statement-breakpoint
CREATE TABLE "methods_of_analysis" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"method_uuid" text NOT NULL,
	"decimal_scale" integer DEFAULT 2 NOT NULL,
	"parse_number" boolean DEFAULT false NOT NULL,
	CONSTRAINT "methods_of_analysis_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "methods_of_analysis_metadata" CHECK (length(trim("methods_of_analysis"."code")) between 1 and 64 and length(trim("methods_of_analysis"."name")) between 1 and 250 and "methods_of_analysis"."revision" > 0),
	CONSTRAINT "method_number_settings" CHECK ("methods_of_analysis"."decimal_scale" between 0 and 12 and length(trim("methods_of_analysis"."method_uuid")) between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "parameter_methods" (
	"organization_id" uuid NOT NULL,
	"test_parameter_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "parameter_methods_organization_id_test_parameter_id_method_id_pk" PRIMARY KEY("organization_id","test_parameter_id","method_id")
);
--> statement-breakpoint
CREATE TABLE "product_sample_categories" (
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	CONSTRAINT "product_sample_categories_organization_id_product_id_sample_category_id_pk" PRIMARY KEY("organization_id","product_id","sample_category_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"abbreviation" text,
	"job_template_id" uuid,
	CONSTRAINT "products_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "products_metadata" CHECK (length(trim("products"."code")) between 1 and 64 and length(trim("products"."name")) between 1 and 250 and "products"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "sample_categories" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"abbreviation" text NOT NULL,
	"retention_days" integer,
	"estimated_time_in_days" integer DEFAULT 0 NOT NULL,
	"enable_events" boolean DEFAULT false NOT NULL,
	"enable_reissue" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sample_categories_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_categories_metadata" CHECK (length(trim("sample_categories"."code")) between 1 and 64 and length(trim("sample_categories"."name")) between 1 and 250 and "sample_categories"."revision" > 0),
	CONSTRAINT "sample_categories_settings" CHECK (length(trim("sample_categories"."abbreviation")) between 1 and 64 and "sample_categories"."retention_days" >= 0 and "sample_categories"."estimated_time_in_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sample_category_templates" (
	"organization_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sample_category_templates_organization_id_sample_category_id_template_id_purpose_pk" PRIMARY KEY("organization_id","sample_category_id","template_id","purpose"),
	CONSTRAINT "sample_category_template_purpose" CHECK ("sample_category_templates"."purpose" in ('sample', 'datasheet', 'report', 'label'))
);
--> statement-breakpoint
CREATE TABLE "test_parameters" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"laboratory_id" uuid,
	"measurement_unit_id" uuid,
	"default_scale" integer DEFAULT 2 NOT NULL,
	"master_key" text NOT NULL,
	"scheme_abbreviation" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "test_parameters_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "test_parameters_metadata" CHECK (length(trim("test_parameters"."code")) between 1 and 64 and length(trim("test_parameters"."name")) between 1 and 250 and "test_parameters"."revision" > 0),
	CONSTRAINT "test_parameter_display" CHECK ("test_parameters"."default_scale" between 0 and 12 and "test_parameters"."display_order" >= 0 and length(trim("test_parameters"."master_key")) between 1 and 64 and length(trim("test_parameters"."scheme_abbreviation")) between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "sample_category_workflows" (
	"organization_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"applies_to" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sample_category_workflows_organization_id_sample_category_id_workflow_id_applies_to_pk" PRIMARY KEY("organization_id","sample_category_id","workflow_id","applies_to"),
	CONSTRAINT "sample_category_workflow_type" CHECK ("sample_category_workflows"."applies_to" in ('sample', 'test_request'))
);
--> statement-breakpoint
CREATE TABLE "workflow_state_capability_roles" (
	"organization_id" uuid NOT NULL,
	"workflow_state_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "workflow_state_capability_role_pk" PRIMARY KEY("organization_id","workflow_state_id","capability","role_id"),
	CONSTRAINT "workflow_state_capability" CHECK ("workflow_state_capability_roles"."capability" in ('view', 'edit', 'allocate', 'execute', 'review', 'approve', 'cancel', 'download_report'))
);
--> statement-breakpoint
CREATE TABLE "workflow_states" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state_type" text DEFAULT 'normal' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"color" text,
	"template_id" uuid,
	"show_sample_edit" boolean DEFAULT false NOT NULL,
	"show_sample_retest" boolean DEFAULT false NOT NULL,
	"show_sample_reissue" boolean DEFAULT false NOT NULL,
	"enable_template_validation" boolean DEFAULT false NOT NULL,
	"enable_critical_parameters_validation" boolean DEFAULT false NOT NULL,
	"show_add_result" boolean DEFAULT false NOT NULL,
	"generate_test_requests" boolean DEFAULT false NOT NULL,
	"require_all_test_requests_allocated" boolean DEFAULT false NOT NULL,
	"require_all_test_requests_approved" boolean DEFAULT false NOT NULL,
	"fetch_environment_data" boolean DEFAULT false NOT NULL,
	"can_work_on_test_request" boolean DEFAULT false NOT NULL,
	"is_positive_termination" boolean DEFAULT false NOT NULL,
	"enable_job_card" boolean DEFAULT false NOT NULL,
	CONSTRAINT "workflow_states_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_state_version_key" UNIQUE("organization_id","workflow_version_id","id"),
	CONSTRAINT "workflow_state_code_key" UNIQUE("organization_id","workflow_version_id","code"),
	CONSTRAINT "workflow_state_details" CHECK ("workflow_states"."state_type" in ('initial', 'normal', 'final', 'cancelled') and "workflow_states"."display_order" >= 0 and length(trim("workflow_states"."code")) between 1 and 64 and length(trim("workflow_states"."name")) between 1 and 150)
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_summary" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workflow_versions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_version_number_key" UNIQUE("organization_id","workflow_id","number"),
	CONSTRAINT "workflow_version_revision" CHECK ("workflow_versions"."number" > 0 and "workflow_versions"."revision" > 0),
	CONSTRAINT "workflow_version_status" CHECK (("workflow_versions"."status" = 'draft' and "workflow_versions"."published_by" is null and "workflow_versions"."published_at" is null and "workflow_versions"."retired_at" is null)
    or ("workflow_versions"."status" = 'published' and "workflow_versions"."published_by" is not null and "workflow_versions"."published_at" is not null and "workflow_versions"."retired_at" is null)
    or ("workflow_versions"."status" = 'retired' and "workflow_versions"."published_by" is not null and "workflow_versions"."published_at" is not null and "workflow_versions"."retired_at" is not null and "workflow_versions"."retired_at" >= "workflow_versions"."published_at"))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"applies_to" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_entity_type_key" UNIQUE("organization_id","id","applies_to"),
	CONSTRAINT "workflow_metadata" CHECK (length(trim("workflows"."code")) between 1 and 64 and length(trim("workflows"."name")) between 1 and 200 and "workflows"."applies_to" in ('sample', 'test_request'))
);
--> statement-breakpoint
CREATE TABLE "analytical_specification_limits" (
	"organization_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"lower_limit" numeric,
	"upper_limit" numeric,
	"lower_inclusive" boolean NOT NULL,
	"upper_inclusive" boolean NOT NULL,
	"outcome" text NOT NULL,
	"narration" text,
	"display_order" integer NOT NULL,
	CONSTRAINT "analytical_specification_limit_pk" PRIMARY KEY("organization_id","specification_id","id"),
	CONSTRAINT "analytical_specification_limit_bounds" CHECK (num_nonnulls("analytical_specification_limits"."lower_limit", "analytical_specification_limits"."upper_limit") >= 1 and "analytical_specification_limits"."lower_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "analytical_specification_limits"."upper_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and ("analytical_specification_limits"."lower_limit" is null or "analytical_specification_limits"."upper_limit" is null or "analytical_specification_limits"."lower_limit" <= "analytical_specification_limits"."upper_limit") and "analytical_specification_limits"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytical_specifications" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"test_parameter_id" uuid NOT NULL,
	"parameter_revision" integer NOT NULL,
	"parameter_code" text NOT NULL,
	"parameter_name" text NOT NULL,
	"parameter_master_key" text NOT NULL,
	"parameter_scale" integer NOT NULL,
	"method_id" uuid NOT NULL,
	"method_revision" integer NOT NULL,
	"method_code" text NOT NULL,
	"method_name" text NOT NULL,
	"method_description" text NOT NULL,
	"method_uuid" text NOT NULL,
	"decimal_scale" integer NOT NULL,
	"parse_number" boolean NOT NULL,
	"measurement_unit_id" uuid,
	"unit_revision" integer,
	"unit_code" text,
	"unit_name" text,
	"unit_symbol" text,
	"unit_dimension" text,
	"decision_rule_id" uuid,
	"rule_revision" integer,
	"rule_code" text,
	"rule_name" text,
	"template_id" uuid,
	"cutoff_value" numeric,
	"greater_than_text" text,
	"less_than_text" text,
	"minimum_text" text,
	"maximum_text" text,
	"unit_of_measure" text,
	"result_representation" text,
	"default_narration" text,
	"detectable_upper_limit" numeric,
	"detectable_lower_limit" numeric,
	"detectable_upper_limit_text" text,
	"detectable_lower_limit_text" text,
	"show_detectable_limit_text" boolean DEFAULT false NOT NULL,
	"show_standard_limit_text" boolean DEFAULT false NOT NULL,
	"conformance_limit" numeric,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytical_specifications_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "analytical_specification_method_key" UNIQUE("organization_id","id","method_id"),
	CONSTRAINT "analytical_specification_revisions" CHECK ("analytical_specifications"."parameter_revision" > 0 and "analytical_specifications"."method_revision" > 0 and "analytical_specifications"."parameter_scale" between 0 and 12 and "analytical_specifications"."decimal_scale" between 0 and 12),
	CONSTRAINT "analytical_specification_unit" CHECK (("analytical_specifications"."measurement_unit_id" is null and num_nonnulls("analytical_specifications"."unit_revision", "analytical_specifications"."unit_code", "analytical_specifications"."unit_name", "analytical_specifications"."unit_symbol", "analytical_specifications"."unit_dimension") = 0)
    or ("analytical_specifications"."measurement_unit_id" is not null and "analytical_specifications"."unit_revision" is not null and "analytical_specifications"."unit_revision" > 0 and "analytical_specifications"."unit_code" is not null and "analytical_specifications"."unit_name" is not null and "analytical_specifications"."unit_symbol" is not null)),
	CONSTRAINT "analytical_specification_rule" CHECK (("analytical_specifications"."decision_rule_id" is null and "analytical_specifications"."rule_revision" is null and "analytical_specifications"."rule_code" is null and "analytical_specifications"."rule_name" is null)
    or ("analytical_specifications"."decision_rule_id" is not null and "analytical_specifications"."rule_revision" is not null and "analytical_specifications"."rule_revision" > 0 and "analytical_specifications"."rule_code" is not null and "analytical_specifications"."rule_name" is not null)),
	CONSTRAINT "analytical_specification_numbers" CHECK ("analytical_specifications"."cutoff_value" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "analytical_specifications"."detectable_upper_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "analytical_specifications"."detectable_lower_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "analytical_specifications"."conformance_limit" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
--> statement-breakpoint
CREATE TABLE "datasheets" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"test_request_id" uuid NOT NULL,
	"template_instance_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	CONSTRAINT "datasheets_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "datasheet_request_id_key" UNIQUE("organization_id","test_request_id","id"),
	CONSTRAINT "datasheet_capture_key" UNIQUE("organization_id","template_instance_id"),
	CONSTRAINT "datasheet_attempt_key" UNIQUE("organization_id","test_request_id","attempt_number"),
	CONSTRAINT "datasheet_status" CHECK ("datasheets"."status" in ('in_progress', 'completed', 'under_review', 'approved', 'rejected', 'void') and "datasheets"."revision" > 0 and "datasheets"."attempt_number" > 0),
	CONSTRAINT "datasheet_completion" CHECK (("datasheets"."completed_at" is null) = ("datasheets"."completed_by" is null) and ("datasheets"."status" not in ('completed', 'under_review', 'approved') or "datasheets"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"organization_id" uuid NOT NULL,
	"sequence_key" text NOT NULL,
	"period_key" text NOT NULL,
	"prefix" text NOT NULL,
	"minimum_width" integer DEFAULT 6 NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "number_sequences_organization_id_sequence_key_period_key_pk" PRIMARY KEY("organization_id","sequence_key","period_key"),
	CONSTRAINT "number_sequence_shape" CHECK ("number_sequences"."sequence_key" in ('sample', 'test_request', 'job') and "number_sequences"."period_key" ~ '^[0-9]{4}$' and "number_sequences"."next_value" > 0 and "number_sequences"."minimum_width" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "sample_events" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sample_id" uuid NOT NULL,
	"test_request_id" uuid,
	"event_type" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"description" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_events_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_event_type" CHECK ("sample_events"."event_type" in ('sample_registered', 'test_requests_generated', 'test_request_assigned', 'datasheet_created', 'datasheet_submitted'))
);
--> statement-breakpoint
CREATE TABLE "sample_participating_labs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sample_id" uuid NOT NULL,
	"laboratory_id" uuid,
	"laboratory_name" text NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "sample_participating_labs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_participating_lab_order_key" UNIQUE("organization_id","sample_id","display_order"),
	CONSTRAINT "sample_participating_lab_details" CHECK (length(trim("sample_participating_labs"."laboratory_name")) between 1 and 250 and "sample_participating_labs"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sample_products" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sample_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"category_code" text NOT NULL,
	"category_name" text NOT NULL,
	"quantity" numeric DEFAULT '1' NOT NULL,
	"customer_reference" text,
	"description" text,
	"display_order" integer NOT NULL,
	"sample_size" text,
	"quality" text,
	"identification_mark" text,
	"received_condition" text,
	"measurement_unit_id" uuid,
	"unit_code" text,
	"unit_symbol" text,
	"tag" text,
	CONSTRAINT "sample_products_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_product_order_key" UNIQUE("organization_id","sample_id","display_order"),
	CONSTRAINT "sample_product_quantity" CHECK ("sample_products"."quantity" > 0 and "sample_products"."quantity" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "sample_products"."display_order" >= 0),
	CONSTRAINT "sample_product_unit" CHECK (("sample_products"."measurement_unit_id" is null and "sample_products"."unit_code" is null and "sample_products"."unit_symbol" is null) or ("sample_products"."measurement_unit_id" is not null and "sample_products"."unit_code" is not null and "sample_products"."unit_symbol" is not null))
);
--> statement-breakpoint
CREATE TABLE "sample_tests" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sample_product_id" uuid NOT NULL,
	"test_parameter_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"decision_rule_id" uuid,
	"requested_quantity" integer DEFAULT 1 NOT NULL,
	"requested_size" text,
	"rate" numeric,
	"currency_code" text,
	"estimated_duration_minutes" integer,
	"is_accredited" boolean DEFAULT false NOT NULL,
	"is_retest" boolean DEFAULT false NOT NULL,
	"is_subcontracted" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "sample_tests_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_test_selection_key" UNIQUE("organization_id","sample_product_id","test_parameter_id","method_id","is_retest"),
	CONSTRAINT "sample_test_order_key" UNIQUE("organization_id","sample_product_id","display_order"),
	CONSTRAINT "sample_test_details" CHECK ("sample_tests"."requested_quantity" > 0 and "sample_tests"."display_order" >= 0 and ("sample_tests"."estimated_duration_minutes" is null or "sample_tests"."estimated_duration_minutes" >= 0) and "sample_tests"."status" in ('planned', 'requested', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "sample_test_rate" CHECK (("sample_tests"."rate" is null and "sample_tests"."currency_code" is null) or ("sample_tests"."rate" is not null and "sample_tests"."currency_code" is not null and "sample_tests"."rate" >= 0 and "sample_tests"."rate" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "sample_tests"."currency_code" ~ '^[A-Z]{3}$'))
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sample_number" text NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"customer_id" uuid,
	"customer_quotation_id" uuid,
	"category_code" text NOT NULL,
	"category_name" text NOT NULL,
	"category_abbreviation" text NOT NULL,
	"customer_code" text,
	"customer_name" text,
	"customer_legal_name" text,
	"customer_address" text,
	"customer_reference" text,
	"sample_type" text DEFAULT 'customer' NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"quantity" numeric,
	"description" text,
	"storage_location" text,
	"retention_due_on" date,
	"iqc_type" text,
	"participant_count" integer,
	"ilc_mode" text,
	"mode_of_receipt" text,
	"total_amount" numeric,
	"currency_code" text,
	"received_by_name" text,
	"collection_details" text,
	"amendment_remarks" text,
	"complaint_remarks" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"registered_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "samples_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_number_key" UNIQUE("organization_id","sample_number"),
	CONSTRAINT "sample_type" CHECK ("samples"."sample_type" in ('customer', 'internal', 'quality_control', 'proficiency', 'interlaboratory', 'amendment', 'complaint')),
	CONSTRAINT "sample_status" CHECK ("samples"."status" in ('registered', 'in_progress', 'on_hold', 'completed', 'rejected', 'cancelled') and "samples"."revision" > 0),
	CONSTRAINT "sample_dates_quantity" CHECK (("samples"."due_at" is null or "samples"."due_at" >= "samples"."received_at") and ("samples"."quantity" is null or ("samples"."quantity" > 0 and "samples"."quantity" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)))),
	CONSTRAINT "sample_customer" CHECK (("samples"."sample_type" <> 'customer' or "samples"."customer_id" is not null) and ("samples"."customer_quotation_id" is null or "samples"."customer_id" is not null)
    and (("samples"."customer_id" is null and num_nonnulls("samples"."customer_code", "samples"."customer_name", "samples"."customer_legal_name") = 0)
      or ("samples"."customer_id" is not null and "samples"."customer_code" is not null and "samples"."customer_name" is not null and "samples"."customer_legal_name" is not null and nullif(trim("samples"."customer_address"), '') is not null))),
	CONSTRAINT "sample_iqc" CHECK (("samples"."iqc_type" is null or "samples"."iqc_type" in ('repetition', 'retest', 'blind', 'int_lab')) and ("samples"."participant_count" is null or "samples"."participant_count" > 0)
    and ("samples"."sample_type" = 'quality_control' or ("samples"."iqc_type" is null and "samples"."participant_count" is null))
    and ("samples"."iqc_type" is distinct from 'int_lab' or "samples"."participant_count" is not null)),
	CONSTRAINT "sample_ilc" CHECK (("samples"."ilc_mode" is null or "samples"."ilc_mode" in ('organizer', 'participant')) and ("samples"."sample_type" = 'interlaboratory' or "samples"."ilc_mode" is null)),
	CONSTRAINT "sample_amount" CHECK (("samples"."total_amount" is null and "samples"."currency_code" is null) or ("samples"."total_amount" is not null and "samples"."currency_code" is not null and "samples"."total_amount" >= 0 and "samples"."total_amount" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and "samples"."currency_code" ~ '^[A-Z]{3}$'))
);
--> statement-breakpoint
CREATE TABLE "test_request_assignments" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"test_request_id" uuid NOT NULL,
	"assigned_user_id" uuid NOT NULL,
	"assignment_type" text NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone,
	CONSTRAINT "test_request_assignments_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "test_request_assignment_details" CHECK ("test_request_assignments"."assignment_type" in ('analyst', 'reviewer', 'final_approver') and ("test_request_assignments"."unassigned_at" is null or "test_request_assignments"."unassigned_at" >= "test_request_assignments"."assigned_at"))
);
--> statement-breakpoint
CREATE TABLE "test_requests" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_number" text NOT NULL,
	"sample_test_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"parent_test_request_id" uuid,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"datasheet_template_id" uuid,
	"final_datasheet_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_requests_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "test_request_number_key" UNIQUE("organization_id","request_number"),
	CONSTRAINT "test_request_attempt_key" UNIQUE("organization_id","sample_test_id","attempt_number"),
	CONSTRAINT "test_request_state" CHECK ("test_requests"."status" in ('created', 'allocated', 'in_progress', 'under_review', 'approved', 'rejected', 'cancelled') and "test_requests"."priority" in ('low', 'normal', 'high', 'urgent') and "test_requests"."revision" > 0 and "test_requests"."attempt_number" > 0),
	CONSTRAINT "test_request_dates" CHECK ("test_requests"."completed_at" is null or "test_requests"."started_at" is null or "test_requests"."completed_at" >= "test_requests"."started_at"),
	CONSTRAINT "test_request_parent" CHECK ("test_requests"."parent_test_request_id" is distinct from "test_requests"."id")
);
--> statement-breakpoint
CREATE TABLE "workflow_run_history" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"from_state_id" uuid,
	"to_state_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"comment" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_history_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_run_history_action" CHECK ("workflow_run_history"."action" in ('started', 'transitioned', 'approved', 'rejected', 'cancelled', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"sample_id" uuid,
	"test_request_id" uuid,
	"current_state_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_run_sample_key" UNIQUE("organization_id","sample_id"),
	CONSTRAINT "workflow_run_request_key" UNIQUE("organization_id","test_request_id"),
	CONSTRAINT "workflow_run_version_key" UNIQUE("organization_id","id","workflow_version_id"),
	CONSTRAINT "workflow_run_owner" CHECK (num_nonnulls("workflow_runs"."sample_id", "workflow_runs"."test_request_id") = 1),
	CONSTRAINT "workflow_run_state" CHECK ("workflow_runs"."status" in ('active', 'completed', 'cancelled') and "workflow_runs"."revision" > 0 and ("workflow_runs"."completed_at" is null or "workflow_runs"."completed_at" >= "workflow_runs"."started_at"))
);
--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_organization_id_customer_id_customers_organization_id_id_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_customer_id_customers_organization_id_id_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_quotations" ADD CONSTRAINT "customer_quotations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_quotations" ADD CONSTRAINT "customer_quotations_organization_id_customer_id_customers_organization_id_id_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_limits" ADD CONSTRAINT "decision_rule_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_limits" ADD CONSTRAINT "decision_rule_limits_organization_id_decision_rule_id_decision_rules_organization_id_id_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_organization_id_product_id_products_organization_id_id_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_organization_id_test_parameter_id_test_parameters_organization_id_id_fk" FOREIGN KEY ("organization_id","test_parameter_id") REFERENCES "public"."test_parameters"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_organization_id_method_id_methods_of_analysis_organization_id_id_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_organization_id_sample_category_id_sample_categories_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_organization_id_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratories" ADD CONSTRAINT "laboratories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_units" ADD CONSTRAINT "measurement_units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD CONSTRAINT "methods_of_analysis_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_methods" ADD CONSTRAINT "parameter_methods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_methods" ADD CONSTRAINT "parameter_methods_organization_id_test_parameter_id_test_parameters_organization_id_id_fk" FOREIGN KEY ("organization_id","test_parameter_id") REFERENCES "public"."test_parameters"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_methods" ADD CONSTRAINT "parameter_methods_organization_id_method_id_methods_of_analysis_organization_id_id_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sample_categories" ADD CONSTRAINT "product_sample_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sample_categories" ADD CONSTRAINT "product_sample_categories_organization_id_product_id_products_organization_id_id_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sample_categories" ADD CONSTRAINT "product_sample_categories_organization_id_sample_category_id_sample_categories_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_job_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","job_template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_categories" ADD CONSTRAINT "sample_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_templates" ADD CONSTRAINT "sample_category_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_templates" ADD CONSTRAINT "sample_category_templates_organization_id_sample_category_id_sample_categories_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_templates" ADD CONSTRAINT "sample_category_templates_organization_id_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameters" ADD CONSTRAINT "test_parameters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameters" ADD CONSTRAINT "test_parameters_organization_id_laboratory_id_laboratories_organization_id_id_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameters" ADD CONSTRAINT "test_parameters_organization_id_measurement_unit_id_measurement_units_organization_id_id_fk" FOREIGN KEY ("organization_id","measurement_unit_id") REFERENCES "public"."measurement_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_workflows" ADD CONSTRAINT "sample_category_workflows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_workflows" ADD CONSTRAINT "sample_category_workflows_organization_id_sample_category_id_sample_categories_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_workflows" ADD CONSTRAINT "sample_category_workflows_organization_id_workflow_id_applies_to_workflows_organization_id_id_applies_to_fk" FOREIGN KEY ("organization_id","workflow_id","applies_to") REFERENCES "public"."workflows"("organization_id","id","applies_to") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state_capability_roles" ADD CONSTRAINT "workflow_state_capability_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state_capability_roles" ADD CONSTRAINT "workflow_state_capability_roles_organization_id_workflow_state_id_workflow_states_organization_id_id_fk" FOREIGN KEY ("organization_id","workflow_state_id") REFERENCES "public"."workflow_states"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state_capability_roles" ADD CONSTRAINT "workflow_state_capability_roles_organization_id_role_id_roles_organization_id_id_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_organization_id_workflow_version_id_workflow_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_organization_id_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_workflow_id_workflows_organization_id_id_fk" FOREIGN KEY ("organization_id","workflow_id") REFERENCES "public"."workflows"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_published_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","published_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specification_limits" ADD CONSTRAINT "analytical_specification_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specification_limits" ADD CONSTRAINT "analytical_specification_limits_organization_id_specification_id_analytical_specifications_organization_id_id_fk" FOREIGN KEY ("organization_id","specification_id") REFERENCES "public"."analytical_specifications"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_test_parameter_id_test_parameters_organization_id_id_fk" FOREIGN KEY ("organization_id","test_parameter_id") REFERENCES "public"."test_parameters"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_method_id_methods_of_analysis_organization_id_id_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_measurement_unit_id_measurement_units_organization_id_id_fk" FOREIGN KEY ("organization_id","measurement_unit_id") REFERENCES "public"."measurement_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_decision_rule_id_decision_rules_organization_id_id_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytical_specifications" ADD CONSTRAINT "analytical_specifications_organization_id_recorded_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","recorded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_template_instance_id_template_instances_organization_id_id_fk" FOREIGN KEY ("organization_id","template_instance_id") REFERENCES "public"."template_instances"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_method_id_methods_of_analysis_organization_id_id_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_completed_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","completed_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheets_organization_id_specification_id_method_id_analytical_specifications_organization_id_id_method_id_fk" FOREIGN KEY ("organization_id","specification_id","method_id") REFERENCES "public"."analytical_specifications"("organization_id","id","method_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_organization_id_sample_id_samples_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_id") REFERENCES "public"."samples"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_organization_id_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_organization_id_actor_user_id_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_participating_labs" ADD CONSTRAINT "sample_participating_labs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_participating_labs" ADD CONSTRAINT "sample_participating_labs_organization_id_sample_id_samples_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_id") REFERENCES "public"."samples"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_participating_labs" ADD CONSTRAINT "sample_participating_labs_organization_id_laboratory_id_laboratories_organization_id_id_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_sample_id_samples_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_id") REFERENCES "public"."samples"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_product_id_products_organization_id_id_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_sample_category_id_sample_categories_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_measurement_unit_id_measurement_units_organization_id_id_fk" FOREIGN KEY ("organization_id","measurement_unit_id") REFERENCES "public"."measurement_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_product_id_sample_category_id_product_sample_categories_organization_id_product_id_sample_category_id_fk" FOREIGN KEY ("organization_id","product_id","sample_category_id") REFERENCES "public"."product_sample_categories"("organization_id","product_id","sample_category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_tests" ADD CONSTRAINT "sample_tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_tests" ADD CONSTRAINT "sample_tests_organization_id_sample_product_id_sample_products_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_product_id") REFERENCES "public"."sample_products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_tests" ADD CONSTRAINT "sample_tests_organization_id_test_parameter_id_test_parameters_organization_id_id_fk" FOREIGN KEY ("organization_id","test_parameter_id") REFERENCES "public"."test_parameters"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_tests" ADD CONSTRAINT "sample_tests_organization_id_method_id_methods_of_analysis_organization_id_id_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_tests" ADD CONSTRAINT "sample_tests_organization_id_decision_rule_id_decision_rules_organization_id_id_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_tests" ADD CONSTRAINT "sample_tests_organization_id_test_parameter_id_method_id_parameter_methods_organization_id_test_parameter_id_method_id_fk" FOREIGN KEY ("organization_id","test_parameter_id","method_id") REFERENCES "public"."parameter_methods"("organization_id","test_parameter_id","method_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organization_id_sample_category_id_sample_categories_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organization_id_customer_id_customers_organization_id_id_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organization_id_registered_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","registered_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organization_id_customer_id_customer_quotation_id_customer_quotations_organization_id_customer_id_id_fk" FOREIGN KEY ("organization_id","customer_id","customer_quotation_id") REFERENCES "public"."customer_quotations"("organization_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_request_assignments" ADD CONSTRAINT "test_request_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_request_assignments" ADD CONSTRAINT "test_request_assignments_organization_id_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_request_assignments" ADD CONSTRAINT "test_request_assignments_organization_id_assigned_user_id_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","assigned_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_request_assignments" ADD CONSTRAINT "test_request_assignments_organization_id_assigned_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","assigned_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_sample_test_id_sample_tests_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_test_id") REFERENCES "public"."sample_tests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_specification_id_analytical_specifications_organization_id_id_fk" FOREIGN KEY ("organization_id","specification_id") REFERENCES "public"."analytical_specifications"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_parent_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_datasheet_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","datasheet_template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_request_final_datasheet_fk" FOREIGN KEY ("organization_id","id","final_datasheet_id") REFERENCES "public"."datasheets"("organization_id","test_request_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_run_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_run_history_organization_id_actor_user_id_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_run_history_organization_id_workflow_run_id_workflow_version_id_workflow_runs_organization_id_id_workflow_version_id_fk" FOREIGN KEY ("organization_id","workflow_run_id","workflow_version_id") REFERENCES "public"."workflow_runs"("organization_id","id","workflow_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_run_history_organization_id_workflow_version_id_from_state_id_workflow_states_organization_id_workflow_version_id_id_fk" FOREIGN KEY ("organization_id","workflow_version_id","from_state_id") REFERENCES "public"."workflow_states"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_run_history_organization_id_workflow_version_id_to_state_id_workflow_states_organization_id_workflow_version_id_id_fk" FOREIGN KEY ("organization_id","workflow_version_id","to_state_id") REFERENCES "public"."workflow_states"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_workflow_version_id_workflow_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_sample_id_samples_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_id") REFERENCES "public"."samples"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_started_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","started_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_workflow_version_id_current_state_id_workflow_states_organization_id_workflow_version_id_id_fk" FOREIGN KEY ("organization_id","workflow_version_id","current_state_id") REFERENCES "public"."workflow_states"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_default_address_key" ON "customer_addresses" USING btree ("organization_id","customer_id","address_type") WHERE "customer_addresses"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_primary_contact_key" ON "customer_contacts" USING btree ("organization_id","customer_id") WHERE "customer_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "customer_quotation_date_idx" ON "customer_quotations" USING btree ("organization_id","customer_id","quotation_date");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_code_key" ON "customers" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE INDEX "decision_rule_limits_order" ON "decision_rule_limits" USING btree ("organization_id","decision_rule_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rules_code_key" ON "decision_rules" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rule_unique_key" ON "decision_rules" USING btree ("organization_id",lower("unique_key")) WHERE "decision_rules"."unique_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "laboratories_code_key" ON "laboratories" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_units_code_key" ON "measurement_units" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "methods_of_analysis_code_key" ON "methods_of_analysis" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "method_uuid_key" ON "methods_of_analysis" USING btree ("organization_id",lower("method_uuid"));--> statement-breakpoint
CREATE UNIQUE INDEX "parameter_default_method_key" ON "parameter_methods" USING btree ("organization_id","test_parameter_id") WHERE "parameter_methods"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "products_code_key" ON "products" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "sample_categories_code_key" ON "sample_categories" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "sample_category_default_template_key" ON "sample_category_templates" USING btree ("organization_id","sample_category_id","purpose") WHERE "sample_category_templates"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "test_parameters_code_key" ON "test_parameters" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "test_parameter_master_key" ON "test_parameters" USING btree ("organization_id",lower("master_key"));--> statement-breakpoint
CREATE UNIQUE INDEX "test_parameter_scheme_key" ON "test_parameters" USING btree ("organization_id",lower("scheme_abbreviation"));--> statement-breakpoint
CREATE UNIQUE INDEX "sample_category_default_workflow_key" ON "sample_category_workflows" USING btree ("organization_id","sample_category_id","applies_to") WHERE "sample_category_workflows"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_single_state_type_key" ON "workflow_states" USING btree ("organization_id","workflow_version_id","state_type") WHERE "workflow_states"."state_type" in ('initial', 'final', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_one_draft_key" ON "workflow_versions" USING btree ("organization_id","workflow_id") WHERE "workflow_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_code_key" ON "workflows" USING btree ("organization_id",lower("code"));--> statement-breakpoint
CREATE INDEX "sample_events_time_idx" ON "sample_events" USING btree ("organization_id","sample_id","occurred_at");--> statement-breakpoint
CREATE INDEX "samples_received_idx" ON "samples" USING btree ("organization_id","received_at","id");--> statement-breakpoint
CREATE INDEX "samples_status_idx" ON "samples" USING btree ("organization_id","status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "test_request_current_assignment_key" ON "test_request_assignments" USING btree ("organization_id","test_request_id","assignment_type") WHERE "test_request_assignments"."unassigned_at" is null;--> statement-breakpoint
CREATE INDEX "test_request_assigned_user_idx" ON "test_request_assignments" USING btree ("organization_id","assigned_user_id") WHERE "test_request_assignments"."unassigned_at" is null;--> statement-breakpoint
CREATE INDEX "test_request_status_idx" ON "test_requests" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_run_history_idx" ON "workflow_run_history" USING btree ("organization_id","workflow_run_id","occurred_at");
