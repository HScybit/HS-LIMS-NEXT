ALTER TABLE "organization_laboratory_settings" ADD COLUMN "date_format" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD COLUMN "datetime_format" text;--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_date_format" CHECK (length("organization_laboratory_settings"."date_format")<=40);--> statement-breakpoint
ALTER TABLE "organization_laboratory_settings" ADD CONSTRAINT "lab_settings_datetime_format" CHECK (length("organization_laboratory_settings"."datetime_format")<=60);