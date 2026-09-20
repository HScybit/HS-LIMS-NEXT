CREATE TABLE "job_result_entries" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"datasheet_id" uuid NOT NULL,
	"child_datasheet_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"value_revision" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "job_result_entries_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "job_result_value_key" UNIQUE("organization_id","instance_id","field_id","occurrence_id","value_revision"),
	CONSTRAINT "job_result_order_key" UNIQUE("organization_id","instance_id","value_revision","position"),
	CONSTRAINT "job_result_position" CHECK ("job_result_entries"."value_revision">0 and "job_result_entries"."position" between 0 and 999)
);
--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_widget_type";--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD CONSTRAINT "job_result_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD CONSTRAINT "job_result_entries_organization_id_child_datasheet_id_datasheets_organization_id_id_fk" FOREIGN KEY ("organization_id","child_datasheet_id") REFERENCES "public"."datasheets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD CONSTRAINT "job_result_entries_organization_id_subject_id_datasheet_subjects_organization_id_id_fk" FOREIGN KEY ("organization_id","subject_id") REFERENCES "public"."datasheet_subjects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD CONSTRAINT "job_result_capture_fk" FOREIGN KEY ("organization_id","datasheet_id","instance_id") REFERENCES "public"."datasheets"("organization_id","id","template_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_result_entries" ADD CONSTRAINT "job_result_value_fk" FOREIGN KEY ("organization_id","instance_id","field_id","occurrence_id","value_revision") REFERENCES "public"."template_values"("organization_id","instance_id","field_id","occurrence_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_result_child_history_idx" ON "job_result_entries" USING btree ("organization_id","child_datasheet_id","value_revision");--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget', 'result_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option'));