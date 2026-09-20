CREATE TABLE "job_workflow_effects" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_history_id" uuid NOT NULL,
	"job_submission_member_id" uuid NOT NULL,
	"child_workflow_run_id" uuid,
	"child_workflow_version_id" uuid,
	"child_state_id" uuid,
	"child_run_revision" integer,
	CONSTRAINT "job_workflow_effects_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "job_effect_history_member_key" UNIQUE("organization_id","parent_history_id","job_submission_member_id"),
	CONSTRAINT "job_effect_child_context" CHECK (num_nonnulls("job_workflow_effects"."child_workflow_run_id","job_workflow_effects"."child_workflow_version_id","job_workflow_effects"."child_state_id","job_workflow_effects"."child_run_revision")=0
    or (num_nonnulls("job_workflow_effects"."child_workflow_run_id","job_workflow_effects"."child_workflow_version_id","job_workflow_effects"."child_state_id","job_workflow_effects"."child_run_revision")=4 and "job_workflow_effects"."child_run_revision">0))
);
--> statement-breakpoint
ALTER TABLE "job_workflow_effects" ADD CONSTRAINT "job_workflow_effects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_workflow_effects" ADD CONSTRAINT "job_workflow_effects_organization_id_parent_history_id_workflow_run_history_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_history_id") REFERENCES "public"."workflow_run_history"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_workflow_effects" ADD CONSTRAINT "job_workflow_effects_organization_id_job_submission_member_id_job_submission_members_organization_id_id_fk" FOREIGN KEY ("organization_id","job_submission_member_id") REFERENCES "public"."job_submission_members"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_workflow_effects" ADD CONSTRAINT "job_effect_child_run_fk" FOREIGN KEY ("organization_id","child_workflow_run_id","child_workflow_version_id") REFERENCES "public"."workflow_runs"("organization_id","id","workflow_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_workflow_effects" ADD CONSTRAINT "job_effect_child_state_fk" FOREIGN KEY ("organization_id","child_workflow_version_id","child_state_id") REFERENCES "public"."workflow_states"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_effect_child_run_idx" ON "job_workflow_effects" USING btree ("organization_id","child_workflow_run_id");