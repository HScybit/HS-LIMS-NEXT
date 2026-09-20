CREATE TABLE "job_submission_members" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_submission_id" uuid NOT NULL,
	"test_request_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	CONSTRAINT "job_submission_members_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "job_submission_member_key" UNIQUE("organization_id","parent_submission_id","test_request_id"),
	CONSTRAINT "job_submission_result_key" UNIQUE("organization_id","parent_submission_id","submission_id")
);
--> statement-breakpoint
ALTER TABLE "datasheet_submissions" DROP CONSTRAINT "submission_capture_revision_key";--> statement-breakpoint
ALTER TABLE "datasheet_submissions" DROP CONSTRAINT "submission_source";--> statement-breakpoint
ALTER TABLE "datasheet_submissions" DROP CONSTRAINT "submission_datasheet_capture_fk";
--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD COLUMN "source_datasheet_id" uuid;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD COLUMN "specification_id" uuid;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD COLUMN "job_result_entry_id" uuid;--> statement-breakpoint
-- Existing submissions already have an exact own-capture FK. Backfill only
-- the new provenance columns from that existing relationship. The migration's
-- exclusive table lock and transaction keep this one-time operation atomic.
ALTER TABLE "datasheet_submissions" DISABLE TRIGGER submission_append_only;--> statement-breakpoint
UPDATE datasheet_submissions submission SET source_datasheet_id=submission.datasheet_id,specification_id=sheet.specification_id
  FROM datasheets sheet WHERE sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ENABLE TRIGGER submission_append_only;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ALTER COLUMN "source_datasheet_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_submission_members" ADD CONSTRAINT "job_submission_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_submission_members" ADD CONSTRAINT "job_submission_members_organization_id_parent_submission_id_datasheet_submissions_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_submission_id") REFERENCES "public"."datasheet_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_submission_members" ADD CONSTRAINT "job_submission_members_organization_id_test_request_id_test_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","test_request_id") REFERENCES "public"."test_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_submission_members" ADD CONSTRAINT "job_submission_members_organization_id_submission_id_datasheet_submissions_organization_id_id_fk" FOREIGN KEY ("organization_id","submission_id") REFERENCES "public"."datasheet_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "datasheet_submissions_organization_id_datasheet_id_datasheets_organization_id_id_fk" FOREIGN KEY ("organization_id","datasheet_id") REFERENCES "public"."datasheets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "datasheet_submissions_organization_id_specification_id_analytical_specifications_organization_id_id_fk" FOREIGN KEY ("organization_id","specification_id") REFERENCES "public"."analytical_specifications"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "datasheet_submissions_organization_id_job_result_entry_id_job_result_entries_organization_id_id_fk" FOREIGN KEY ("organization_id","job_result_entry_id") REFERENCES "public"."job_result_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "submission_source_capture_fk" FOREIGN KEY ("organization_id","source_datasheet_id","instance_id") REFERENCES "public"."datasheets"("organization_id","id","template_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "submission_capture_revision_key" UNIQUE("organization_id","instance_id","capture_revision","datasheet_id");--> statement-breakpoint
ALTER TABLE "datasheet_submissions" ADD CONSTRAINT "submission_source" CHECK ("datasheet_submissions"."selection_semantics" = 'source-agreement-v1' and (
    ("datasheet_submissions"."source" in ('section', 'column') and "datasheet_submissions"."source_datasheet_id"="datasheet_submissions"."datasheet_id" and "datasheet_submissions"."job_result_entry_id" is null)
    or ("datasheet_submissions"."source"='result_widget' and "datasheet_submissions"."source_datasheet_id"<>"datasheet_submissions"."datasheet_id" and "datasheet_submissions"."job_result_entry_id" is not null and "datasheet_submissions"."specification_id" is not null)));
