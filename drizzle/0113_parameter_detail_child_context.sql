-- Generated child reports own their selected parameter membership. The parent
-- sample count is not part of that fallback or the report's historical input.
DROP TRIGGER report_parameter_count_guard ON sample_reports;
--> statement-breakpoint
DROP FUNCTION report_guard_parameter_count();
--> statement-breakpoint
ALTER TABLE "sample_reports" DROP CONSTRAINT "report_sample_parameter_count";--> statement-breakpoint
ALTER TABLE "sample_reports" DROP COLUMN "sample_parameter_count";
