CREATE TABLE "datasheet_submissions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"datasheet_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"instance_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"capture_revision" integer NOT NULL,
	"field_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"value_revision" integer NOT NULL,
	"source" text NOT NULL,
	"selection_semantics" text NOT NULL,
	"result_type" text NOT NULL,
	"number_value" numeric,
	"text_value" text,
	"boolean_value" boolean,
	"measurement_unit_id" uuid,
	"unit_revision" integer,
	"unit_code" text,
	"unit_name" text,
	"unit_symbol" text,
	"unit_dimension" text,
	"narration" text,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasheet_submissions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "submission_datasheet_id_key" UNIQUE("organization_id","datasheet_id","id"),
	CONSTRAINT "submission_number_key" UNIQUE("organization_id","datasheet_id","number"),
	CONSTRAINT "submission_capture_revision_key" UNIQUE("organization_id","instance_id","capture_revision"),
	CONSTRAINT "submission_revision" CHECK ("datasheet_submissions"."number" > 0 and "datasheet_submissions"."capture_revision" > 0 and "datasheet_submissions"."value_revision" > 0 and "datasheet_submissions"."value_revision" <= "datasheet_submissions"."capture_revision"),
	CONSTRAINT "submission_source" CHECK ("datasheet_submissions"."source" in ('section', 'column') and "datasheet_submissions"."selection_semantics" = 'source-agreement-v1'),
	CONSTRAINT "submission_payload" CHECK (num_nonnulls("datasheet_submissions"."number_value", "datasheet_submissions"."text_value", "datasheet_submissions"."boolean_value") = 1 and (
    ("datasheet_submissions"."result_type" = 'numeric' and "datasheet_submissions"."number_value" is not null and "datasheet_submissions"."number_value" not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) or
    ("datasheet_submissions"."result_type" = 'text' and "datasheet_submissions"."text_value" is not null and length(trim("datasheet_submissions"."text_value")) between 1 and 100000) or
    ("datasheet_submissions"."result_type" = 'boolean' and "datasheet_submissions"."boolean_value" is not null))),
	CONSTRAINT "submission_unit" CHECK (("datasheet_submissions"."measurement_unit_id" is null and num_nonnulls("datasheet_submissions"."unit_revision", "datasheet_submissions"."unit_code", "datasheet_submissions"."unit_name", "datasheet_submissions"."unit_symbol", "datasheet_submissions"."unit_dimension") = 0)
    or ("datasheet_submissions"."measurement_unit_id" is not null and "datasheet_submissions"."unit_revision" is not null and "datasheet_submissions"."unit_revision" > 0 and "datasheet_submissions"."unit_code" is not null and "datasheet_submissions"."unit_name" is not null and "datasheet_submissions"."unit_symbol" is not null)),
	CONSTRAINT "submission_narration" CHECK ("datasheet_submissions"."narration" is null or length("datasheet_submissions"."narration") <= 5000)
);
--> statement-breakpoint
ALTER TABLE "datasheets" ADD COLUMN "latest_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheet_instance_id_key" UNIQUE("organization_id","id","template_instance_id");--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "datasheet_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "datasheet_submissions_organization_id_submitted_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","submitted_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "datasheet_submissions_organization_id_measurement_unit_id_measurement_units_organization_id_id_fk" FOREIGN KEY ("organization_id","measurement_unit_id") REFERENCES "public"."measurement_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "submission_datasheet_capture_fk" FOREIGN KEY ("organization_id","datasheet_id","instance_id") REFERENCES "public"."datasheets"("organization_id","id","template_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "submission_capture_version_fk" FOREIGN KEY ("organization_id","instance_id","version_id") REFERENCES "public"."template_instances"("organization_id","id","version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "submission_selected_value_fk" FOREIGN KEY ("organization_id","instance_id","field_id","occurrence_id","value_revision") REFERENCES "public"."template_values"("organization_id","instance_id","field_id","occurrence_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheet_latest_submission_fk" FOREIGN KEY ("organization_id","id","latest_submission_id") REFERENCES "public"."datasheet_submissions"("organization_id","datasheet_id","id") ON DELETE no action ON UPDATE no action;
