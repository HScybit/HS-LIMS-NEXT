CREATE TABLE "template_capture_revisions" (
	"organization_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"transaction_id" "xid8" NOT NULL,
	"recorded_by" uuid,
	"database_role" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "template_capture_revisions_organization_id_instance_id_revision_pk" PRIMARY KEY("organization_id","instance_id","revision"),
	CONSTRAINT "capture_revision_state" CHECK ("template_capture_revisions"."revision">0 and "template_capture_revisions"."status" in ('editing','frozen')),
	CONSTRAINT "capture_revision_actor" CHECK (length("template_capture_revisions"."database_role")>0 and ("template_capture_revisions"."database_role"<>'sampleify_app' or "template_capture_revisions"."recorded_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "template_capture_revisions" ADD CONSTRAINT "template_capture_revisions_organization_id_instance_id_template_instances_organization_id_id_fk" FOREIGN KEY ("organization_id","instance_id") REFERENCES "public"."template_instances"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_capture_revisions" ADD CONSTRAINT "template_capture_revisions_organization_id_recorded_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","recorded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_submission_member_request_idx" ON "job_submission_members" USING btree ("organization_id","test_request_id");