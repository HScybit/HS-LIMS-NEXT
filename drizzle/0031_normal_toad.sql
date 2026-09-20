CREATE TABLE "approval_decision_checklist_answers" (
	"organization_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"checklist_item_id" uuid NOT NULL,
	"is_checked" boolean NOT NULL,
	CONSTRAINT "approval_decision_check_pk" PRIMARY KEY("organization_id","decision_id","checklist_item_id")
);
--> statement-breakpoint
ALTER TABLE "approval_decision_checklist_answers" ADD CONSTRAINT "approval_decision_checklist_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision_checklist_answers" ADD CONSTRAINT "approval_check_decision_fk" FOREIGN KEY ("organization_id","decision_id") REFERENCES "public"."approval_decisions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision_checklist_answers" ADD CONSTRAINT "approval_check_item_fk" FOREIGN KEY ("organization_id","transition_id","checklist_item_id") REFERENCES "public"."workflow_transition_checklist_items"("organization_id","transition_id","id") ON DELETE no action ON UPDATE no action;