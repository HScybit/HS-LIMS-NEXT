CREATE TABLE "organization_laboratory_settings" (
	"organization_id" uuid NOT NULL,
	"auto_create_jobs" boolean DEFAULT false NOT NULL,
	"result_summary_template_id" uuid,
	"job_workflow_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_laboratory_settings_organization_id_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "lab_settings_revision" CHECK ("organization_laboratory_settings"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "datasheets" ALTER COLUMN "specification_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "datasheets" ALTER COLUMN "method_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "test_requests" ALTER COLUMN "sample_test_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "test_requests" ALTER COLUMN "specification_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "test_requests" ADD COLUMN "is_job" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_requests" ADD COLUMN "is_auto_created" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_requests" ADD COLUMN "job_sample_product_id" uuid;--> statement-breakpoint
ALTER TABLE "test_requests" ADD COLUMN "job_member_position" integer;--> statement-breakpoint
ALTER TABLE "test_requests" ADD COLUMN "job_linked_by" uuid;--> statement-breakpoint
ALTER TABLE "test_requests" ADD COLUMN "job_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "organization_laboratory_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_result_template_fk" FOREIGN KEY ("organization_id","result_summary_template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_job_workflow_fk" FOREIGN KEY ("organization_id","job_workflow_id") REFERENCES "public"."workflows"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_actor_fk" FOREIGN KEY ("organization_id","updated_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_job_sample_product_id_sample_products_organization_id_id_fk" FOREIGN KEY ("organization_id","job_sample_product_id") REFERENCES "public"."sample_products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_requests_organization_id_job_linked_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","job_linked_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_request_job_member_position" ON "test_requests" USING btree ("organization_id","parent_test_request_id","job_member_position") WHERE "test_requests"."parent_test_request_id" is not null;--> statement-breakpoint
CREATE INDEX "test_request_job_product_idx" ON "test_requests" USING btree ("organization_id","job_sample_product_id") WHERE "test_requests"."is_job";--> statement-breakpoint
ALTER TABLE "datasheets" ADD CONSTRAINT "datasheet_specification_shape" CHECK (("datasheets"."specification_id" is null)=("datasheets"."method_id" is null));--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_request_kind_shape" CHECK (("test_requests"."is_job" and "test_requests"."sample_test_id" is null and "test_requests"."specification_id" is null and "test_requests"."job_sample_product_id" is not null and "test_requests"."parent_test_request_id" is null)
    or (not "test_requests"."is_job" and not "test_requests"."is_auto_created" and "test_requests"."sample_test_id" is not null and "test_requests"."specification_id" is not null and "test_requests"."job_sample_product_id" is null));--> statement-breakpoint
ALTER TABLE "test_requests" ADD CONSTRAINT "test_request_job_link_shape" CHECK (("test_requests"."parent_test_request_id" is null and num_nonnulls("test_requests"."job_member_position","test_requests"."job_linked_by","test_requests"."job_linked_at")=0)
    or ("test_requests"."parent_test_request_id" is not null and "test_requests"."job_member_position" is not null and "test_requests"."job_member_position">=0 and "test_requests"."job_linked_by" is not null and "test_requests"."job_linked_at" is not null and "test_requests"."parent_test_request_id"<>"test_requests"."id"));