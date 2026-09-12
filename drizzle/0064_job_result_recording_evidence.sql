ALTER TABLE "job_result_entries" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD COLUMN "recorded_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
-- These existing receipts identify the exact saved value, including its actual
-- actor/time. Copy that evidence without inventing historical recording times.
ALTER TABLE job_result_entries DISABLE TRIGGER job_result_entry_append_only;--> statement-breakpoint
UPDATE job_result_entries entry SET recorded_by=value.saved_by,recorded_at=value.saved_at FROM template_values value
  WHERE value.organization_id=entry.organization_id AND value.instance_id=entry.instance_id AND value.field_id=entry.field_id
    AND value.occurrence_id=entry.occurrence_id AND value.revision=entry.value_revision;--> statement-breakpoint
ALTER TABLE job_result_entries ENABLE TRIGGER job_result_entry_append_only;--> statement-breakpoint
ALTER TABLE job_result_entries ALTER COLUMN recorded_by SET NOT NULL;--> statement-breakpoint
ALTER TABLE job_result_entries ALTER COLUMN recorded_at SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD CONSTRAINT "job_result_entries_organization_id_recorded_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","recorded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
