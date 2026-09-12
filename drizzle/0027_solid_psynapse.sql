CREATE TABLE "workflow_transition_approver_roles" (
	"organization_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"stage_number" integer NOT NULL,
	CONSTRAINT "workflow_approver_role_pk" PRIMARY KEY("organization_id","transition_id","stage_number","role_id"),
	CONSTRAINT "workflow_approver_stage_number" CHECK ("workflow_transition_approver_roles"."stage_number" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "workflow_transition_cc_emails" (
	"organization_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "workflow_cc_email_pk" PRIMARY KEY("organization_id","transition_id","email"),
	CONSTRAINT "workflow_cc_email" CHECK (length("workflow_transition_cc_emails"."email") between 3 and 320 and "workflow_transition_cc_emails"."email" = lower(trim("workflow_transition_cc_emails"."email")) and "workflow_transition_cc_emails"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
);
--> statement-breakpoint
CREATE TABLE "workflow_transition_cc_roles" (
	"organization_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "workflow_cc_role_pk" PRIMARY KEY("organization_id","transition_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_transition_checklist_items" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"transition_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workflow_transition_checklist_items_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_checklist_transition_key" UNIQUE("organization_id","transition_id","id"),
	CONSTRAINT "workflow_checklist_details" CHECK (length(trim("workflow_transition_checklist_items"."prompt")) between 1 and 500 and "workflow_transition_checklist_items"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_transition_conditions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"transition_id" uuid NOT NULL,
	"source_field" text NOT NULL,
	"operator" text NOT NULL,
	"comparison_text" text,
	"comparison_number" numeric,
	"comparison_boolean" boolean,
	"comparison_date" date,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workflow_transition_conditions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_condition_details" CHECK (length(trim("workflow_transition_conditions"."source_field")) between 1 and 150 and "workflow_transition_conditions"."operator" in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_null', 'is_not_null')
    and "workflow_transition_conditions"."display_order" >= 0 and num_nonnulls("workflow_transition_conditions"."comparison_text", "workflow_transition_conditions"."comparison_number", "workflow_transition_conditions"."comparison_boolean", "workflow_transition_conditions"."comparison_date") <= 1
    and ("workflow_transition_conditions"."comparison_text" is null or length("workflow_transition_conditions"."comparison_text") <= 5000)
    and ("workflow_transition_conditions"."comparison_number" is null or "workflow_transition_conditions"."comparison_number"::text not in ('NaN', 'Infinity', '-Infinity')))
);
--> statement-breakpoint
CREATE TABLE "workflow_transition_creator_roles" (
	"organization_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "workflow_creator_role_pk" PRIMARY KEY("organization_id","transition_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "approval_assignments" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"approval_stage_id" uuid NOT NULL,
	"assigned_user_id" uuid NOT NULL,
	"source_role_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "approval_assignments_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "approval_assignment_user_key" UNIQUE("organization_id","approval_stage_id","assigned_user_id"),
	CONSTRAINT "approval_assignment_state" CHECK (("approval_assignments"."status" in ('pending', 'cancelled') and "approval_assignments"."responded_at" is null)
    or ("approval_assignments"."status" in ('approved', 'rejected') and "approval_assignments"."responded_at" is not null and "approval_assignments"."responded_at" >= "approval_assignments"."assigned_at"))
);
--> statement-breakpoint
CREATE TABLE "approval_cases" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"request_history_id" uuid NOT NULL,
	"run_revision" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "approval_cases_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "approval_case_request_key" UNIQUE("organization_id","request_history_id"),
	CONSTRAINT "approval_case_state" CHECK ("approval_cases"."run_revision" > 0 and (("approval_cases"."status" = 'pending' and "approval_cases"."resolved_at" is null) or ("approval_cases"."status" in ('approved', 'rejected', 'cancelled') and "approval_cases"."resolved_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"approval_assignment_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "approval_decision_assignment_key" UNIQUE("organization_id","approval_assignment_id"),
	CONSTRAINT "approval_decision_details" CHECK ("approval_decisions"."decision" in ('approve', 'reject') and ("approval_decisions"."comment" is null or length("approval_decisions"."comment") <= 5000))
);
--> statement-breakpoint
CREATE TABLE "approval_stages" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"approval_case_id" uuid NOT NULL,
	"stage_number" integer NOT NULL,
	"completion_rule" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"activated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "approval_stages_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "approval_stage_number_key" UNIQUE("organization_id","approval_case_id","stage_number"),
	CONSTRAINT "approval_stage_details" CHECK ("approval_stages"."stage_number" between 1 and 100 and "approval_stages"."completion_rule" in ('any', 'all')
    and (("approval_stages"."status" = 'waiting' and "approval_stages"."activated_at" is null and "approval_stages"."resolved_at" is null)
      or ("approval_stages"."status" = 'pending' and "approval_stages"."activated_at" is not null and "approval_stages"."resolved_at" is null)
      or ("approval_stages"."status" in ('approved', 'rejected') and "approval_stages"."activated_at" is not null and "approval_stages"."resolved_at" is not null and "approval_stages"."resolved_at" >= "approval_stages"."activated_at")
      or ("approval_stages"."status" = 'cancelled' and "approval_stages"."resolved_at" is not null and ("approval_stages"."activated_at" is null or "approval_stages"."resolved_at" >= "approval_stages"."activated_at"))))
);
--> statement-breakpoint
CREATE TABLE "workflow_checklist_answers" (
	"organization_id" uuid NOT NULL,
	"history_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"checklist_item_id" uuid NOT NULL,
	"is_checked" boolean NOT NULL,
	CONSTRAINT "workflow_checklist_answers_organization_id_history_id_checklist_item_id_pk" PRIMARY KEY("organization_id","history_id","checklist_item_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_run_history" DROP CONSTRAINT "workflow_run_history_action";--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD COLUMN "transition_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_version_key" UNIQUE("organization_id","workflow_version_id","id");--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_history_transition_key" UNIQUE("organization_id","id","transition_id");--> statement-breakpoint
ALTER TABLE "workflow_transition_approver_roles" ADD CONSTRAINT "workflow_transition_approver_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_approver_roles" ADD CONSTRAINT "workflow_transition_approver_roles_organization_id_transition_id_workflow_transitions_organization_id_id_fk" FOREIGN KEY ("organization_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_approver_roles" ADD CONSTRAINT "workflow_transition_approver_roles_organization_id_role_id_roles_organization_id_id_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_cc_emails" ADD CONSTRAINT "workflow_transition_cc_emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_cc_emails" ADD CONSTRAINT "workflow_transition_cc_emails_organization_id_transition_id_workflow_transitions_organization_id_id_fk" FOREIGN KEY ("organization_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_cc_roles" ADD CONSTRAINT "workflow_transition_cc_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_cc_roles" ADD CONSTRAINT "workflow_transition_cc_roles_organization_id_transition_id_workflow_transitions_organization_id_id_fk" FOREIGN KEY ("organization_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_cc_roles" ADD CONSTRAINT "workflow_transition_cc_roles_organization_id_role_id_roles_organization_id_id_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_checklist_items" ADD CONSTRAINT "workflow_transition_checklist_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_checklist_items" ADD CONSTRAINT "workflow_transition_checklist_items_organization_id_transition_id_workflow_transitions_organization_id_id_fk" FOREIGN KEY ("organization_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_conditions" ADD CONSTRAINT "workflow_transition_conditions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_conditions" ADD CONSTRAINT "workflow_transition_conditions_organization_id_transition_id_workflow_transitions_organization_id_id_fk" FOREIGN KEY ("organization_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_creator_roles" ADD CONSTRAINT "workflow_transition_creator_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_creator_roles" ADD CONSTRAINT "workflow_transition_creator_roles_organization_id_transition_id_workflow_transitions_organization_id_id_fk" FOREIGN KEY ("organization_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transition_creator_roles" ADD CONSTRAINT "workflow_transition_creator_roles_organization_id_role_id_roles_organization_id_id_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_organization_id_approval_stage_id_approval_stages_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_stage_id") REFERENCES "public"."approval_stages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_organization_id_assigned_user_id_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","assigned_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_organization_id_source_role_id_roles_organization_id_id_fk" FOREIGN KEY ("organization_id","source_role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_cases" ADD CONSTRAINT "approval_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_cases" ADD CONSTRAINT "approval_case_run_fk" FOREIGN KEY ("organization_id","workflow_run_id","workflow_version_id") REFERENCES "public"."workflow_runs"("organization_id","id","workflow_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_cases" ADD CONSTRAINT "approval_case_transition_fk" FOREIGN KEY ("organization_id","workflow_version_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_cases" ADD CONSTRAINT "approval_case_request_fk" FOREIGN KEY ("organization_id","request_history_id","transition_id") REFERENCES "public"."workflow_run_history"("organization_id","id","transition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_organization_id_approval_assignment_id_approval_assignments_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_assignment_id") REFERENCES "public"."approval_assignments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_organization_id_decided_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","decided_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_stages" ADD CONSTRAINT "approval_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_stages" ADD CONSTRAINT "approval_stages_organization_id_approval_case_id_approval_cases_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_case_id") REFERENCES "public"."approval_cases"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_checklist_answers" ADD CONSTRAINT "workflow_checklist_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_checklist_answers" ADD CONSTRAINT "workflow_answer_history_fk" FOREIGN KEY ("organization_id","history_id","transition_id") REFERENCES "public"."workflow_run_history"("organization_id","id","transition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_checklist_answers" ADD CONSTRAINT "workflow_answer_checklist_fk" FOREIGN KEY ("organization_id","transition_id","checklist_item_id") REFERENCES "public"."workflow_transition_checklist_items"("organization_id","transition_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_assignment_inbox_idx" ON "approval_assignments" USING btree ("organization_id","assigned_user_id","status","assigned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_one_pending_run_key" ON "approval_cases" USING btree ("organization_id","workflow_run_id") WHERE "approval_cases"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_one_pending_stage_key" ON "approval_stages" USING btree ("organization_id","approval_case_id") WHERE "approval_stages"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_history_transition_fk" FOREIGN KEY ("organization_id","workflow_version_id","transition_id") REFERENCES "public"."workflow_transitions"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_history" ADD CONSTRAINT "workflow_run_history_action" CHECK ("workflow_run_history"."action" in ('started', 'requested', 'transitioned', 'approved', 'rejected', 'cancelled', 'completed'));
