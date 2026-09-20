CREATE TABLE "workflow_transitions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"source_state_id" uuid NOT NULL,
	"target_state_id" uuid NOT NULL,
	"approval_mode" text DEFAULT 'none' NOT NULL,
	"auto_execute" boolean DEFAULT false NOT NULL,
	"require_comment" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workflow_transitions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "workflow_transition_code_key" UNIQUE("organization_id","workflow_version_id","code"),
	CONSTRAINT "workflow_transition_details" CHECK ("workflow_transitions"."source_state_id" <> "workflow_transitions"."target_state_id" and "workflow_transitions"."approval_mode" in ('none', 'any', 'all', 'sequential') and "workflow_transitions"."display_order" >= 0 and length(trim("workflow_transitions"."code")) between 1 and 64 and length(trim("workflow_transitions"."name")) between 1 and 150)
);
--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_organization_id_workflow_version_id_workflow_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","workflow_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_source_state_fk" FOREIGN KEY ("organization_id","workflow_version_id","source_state_id") REFERENCES "public"."workflow_states"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_target_state_fk" FOREIGN KEY ("organization_id","workflow_version_id","target_state_id") REFERENCES "public"."workflow_states"("organization_id","workflow_version_id","id") ON DELETE no action ON UPDATE no action;