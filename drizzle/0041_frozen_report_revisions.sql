CREATE TABLE "sample_report_print_settings" (
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"page_size" text DEFAULT 'A4' NOT NULL,
	"scale" numeric DEFAULT '1' NOT NULL,
	"x_margin" numeric DEFAULT '1' NOT NULL,
	"is_landscape" boolean DEFAULT false NOT NULL,
	"print_header" boolean DEFAULT true NOT NULL,
	"print_footer" boolean DEFAULT true NOT NULL,
	"print_without_signature" boolean DEFAULT false NOT NULL,
	"print_without_image" boolean DEFAULT false NOT NULL,
	"use_custom_top_margin" boolean DEFAULT false NOT NULL,
	"top_margin" numeric DEFAULT '1' NOT NULL,
	"use_custom_bottom_margin" boolean DEFAULT false NOT NULL,
	"bottom_margin" numeric DEFAULT '1' NOT NULL,
	CONSTRAINT "report_print_settings_pk" PRIMARY KEY("organization_id","report_id"),
	CONSTRAINT "report_print_settings_shape" CHECK ("sample_report_print_settings"."page_size" in ('A3', 'A4', 'A5', 'Letter', 'Legal') and "sample_report_print_settings"."scale" between 0.1 and 1
    and "sample_report_print_settings"."x_margin" between 0 and 500 and "sample_report_print_settings"."top_margin" between 0 and 500 and "sample_report_print_settings"."bottom_margin" between 0 and 500)
);
--> statement-breakpoint
CREATE TABLE "sample_report_tests" (
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"sample_test_id" uuid NOT NULL,
	"sample_product_id" uuid NOT NULL,
	"test_request_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"decision_limit_id" uuid,
	"display_order" integer NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"request_number" text NOT NULL,
	"analyst_name" text NOT NULL,
	"is_accredited" boolean NOT NULL,
	"request_status" text NOT NULL,
	"datasheet_status" text NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "report_test_pk" PRIMARY KEY("organization_id","report_id","sample_test_id"),
	CONSTRAINT "report_test_order_key" UNIQUE("organization_id","report_id","display_order"),
	CONSTRAINT "report_test_state" CHECK ("sample_report_tests"."display_order" >= 0 and "sample_report_tests"."request_status" in ('under_review', 'approved') and "sample_report_tests"."datasheet_status" in ('under_review', 'approved'))
);
--> statement-breakpoint
CREATE TABLE "sample_reports" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sample_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"report_number" text NOT NULL,
	"revision" integer NOT NULL,
	"report_type" text NOT NULL,
	"group_key" text NOT NULL,
	"sample_product_id" uuid,
	"sample_test_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"generated_by" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"sample_revision" integer NOT NULL,
	"sample_number" text NOT NULL,
	"sample_type" text NOT NULL,
	"sample_category_name" text NOT NULL,
	"customer_name" text,
	"customer_address" text,
	"customer_reference" text,
	"received_at" timestamp with time zone NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"description" text,
	CONSTRAINT "sample_reports_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "report_group_revision_key" UNIQUE("organization_id","sample_id","group_key","revision"),
	CONSTRAINT "report_number_revision_key" UNIQUE("organization_id","report_number","revision"),
	CONSTRAINT "report_revision" CHECK ("sample_reports"."revision" > 0 and "sample_reports"."sample_revision" > 0 and length(trim("sample_reports"."report_number")) between 1 and 100),
	CONSTRAINT "report_group" CHECK (("sample_reports"."report_type" = 'consolidated' and "sample_reports"."group_key" = 'consolidated' and "sample_reports"."sample_product_id" is null and "sample_reports"."sample_test_id" is null)
    or ("sample_reports"."report_type" = 'product_wise' and "sample_reports"."sample_product_id" is not null and "sample_reports"."sample_test_id" is null and "sample_reports"."group_key" = 'product:' || "sample_reports"."sample_product_id"::text)
    or ("sample_reports"."report_type" = 'parameter_wise' and "sample_reports"."sample_product_id" is not null and "sample_reports"."sample_test_id" is not null and "sample_reports"."group_key" = 'parameter:' || "sample_reports"."sample_test_id"::text)),
	CONSTRAINT "report_status" CHECK (("sample_reports"."status" = 'draft' and "sample_reports"."issued_by" is null and "sample_reports"."issued_at" is null)
    or ("sample_reports"."status" in ('issued', 'superseded') and "sample_reports"."issued_by" is not null and "sample_reports"."issued_at" is not null and "sample_reports"."issued_at" >= "sample_reports"."generated_at"))
);
--> statement-breakpoint
ALTER TABLE "number_sequences" DROP CONSTRAINT "number_sequence_shape";--> statement-breakpoint
ALTER TABLE "sample_report_print_settings" ADD CONSTRAINT "sample_report_print_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_print_settings" ADD CONSTRAINT "report_print_settings_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."sample_reports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "sample_report_tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."sample_reports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_selection_fk" FOREIGN KEY ("organization_id","sample_test_id") REFERENCES "public"."sample_tests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_product_fk" FOREIGN KEY ("organization_id","sample_product_id") REFERENCES "public"."sample_products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_request_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_submission_fk" FOREIGN KEY ("organization_id","submission_id") REFERENCES "public"."datasheet_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_specification_fk" FOREIGN KEY ("organization_id","specification_id") REFERENCES "public"."analytical_specifications"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_tests" ADD CONSTRAINT "report_test_decision_limit_fk" FOREIGN KEY ("organization_id","specification_id","decision_limit_id") REFERENCES "public"."analytical_specification_limits"("organization_id","specification_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "sample_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "sample_reports_organization_id_sample_id_samples_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_id") REFERENCES "public"."samples"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "sample_reports_organization_id_template_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","template_version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "sample_reports_organization_id_sample_product_id_sample_products_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_product_id") REFERENCES "public"."sample_products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "sample_reports_organization_id_sample_test_id_sample_tests_organization_id_id_fk" FOREIGN KEY ("organization_id","sample_test_id") REFERENCES "public"."sample_tests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "report_generated_actor_fk" FOREIGN KEY ("organization_id","generated_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "report_issued_actor_fk" FOREIGN KEY ("organization_id","issued_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_sample_history_idx" ON "sample_reports" USING btree ("organization_id","sample_id","generated_at","id");--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequence_shape" CHECK ("number_sequences"."sequence_key" in ('sample', 'test_request', 'job', 'sample_report') and "number_sequences"."period_key" ~ '^[0-9]{4}$' and "number_sequences"."next_value" > 0 and "number_sequences"."minimum_width" between 1 and 20);