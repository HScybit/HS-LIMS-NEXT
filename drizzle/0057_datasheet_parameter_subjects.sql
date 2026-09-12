CREATE TABLE "datasheet_subjects" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"datasheet_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"test_request_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"created_revision" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasheet_subjects_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "datasheet_subject_occurrence_key" UNIQUE("organization_id","instance_id","occurrence_id"),
	CONSTRAINT "datasheet_subject_revision" CHECK ("datasheet_subjects"."created_revision">0)
);
--> statement-breakpoint
ALTER TABLE "template_repeat_groups" DROP CONSTRAINT "repeat_definition_shape";--> statement-breakpoint
ALTER TABLE "datasheet_subjects" ADD CONSTRAINT "datasheet_subjects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_subjects" ADD CONSTRAINT "datasheet_subjects_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_subjects" ADD CONSTRAINT "datasheet_subjects_organization_id_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_subjects" ADD CONSTRAINT "datasheet_subjects_organization_id_specification_id_analytical_specifications_organization_id_id_fk" FOREIGN KEY ("organization_id","specification_id") REFERENCES "public"."analytical_specifications"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_subjects" ADD CONSTRAINT "datasheet_subject_capture_fk" FOREIGN KEY ("organization_id","datasheet_id","instance_id") REFERENCES "public"."datasheets"("organization_id","id","template_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_subjects" ADD CONSTRAINT "datasheet_subject_occurrence_fk" FOREIGN KEY ("organization_id","instance_id","version_id","occurrence_id") REFERENCES "public"."template_occurrences"("organization_id","instance_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "datasheet_subject_request_idx" ON "datasheet_subjects" USING btree ("organization_id","test_request_id","datasheet_id");--> statement-breakpoint
ALTER TABLE "template_repeat_groups" ADD CONSTRAINT "repeat_definition_shape" CHECK (num_nonnulls("template_repeat_groups"."section_id", "template_repeat_groups"."row_id") = 1 and ("template_repeat_groups"."source" = 'manual' or ("template_repeat_groups"."source" = 'test_requests' and "template_repeat_groups"."section_id" is not null)) and "template_repeat_groups"."minimum" between 0 and 1000 and "template_repeat_groups"."maximum" between greatest(1, "template_repeat_groups"."minimum") and 1000 and "template_repeat_groups"."parent_group_id" is distinct from "template_repeat_groups"."id");