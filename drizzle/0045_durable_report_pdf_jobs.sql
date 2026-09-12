CREATE TABLE "report_pdf_artifacts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" "bytea" NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_pdf_artifact_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "report_pdf_artifact_report_key" UNIQUE("organization_id","report_id"),
	CONSTRAINT "report_pdf_artifact_bytes" CHECK ("report_pdf_artifacts"."content_type"='application/pdf' and "report_pdf_artifacts"."byte_length"=octet_length("report_pdf_artifacts"."content") and "report_pdf_artifacts"."byte_length" between 100 and 52428800
    and octet_length("report_pdf_artifacts"."sha256")=32 and "report_pdf_artifacts"."sha256"=sha256("report_pdf_artifacts"."content") and substring("report_pdf_artifacts"."content" from 1 for 5)=convert_to('%PDF-','UTF8'))
);
--> statement-breakpoint
CREATE TABLE "report_pdf_attempts" (
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "report_pdf_attempt_pk" PRIMARY KEY("organization_id","job_id","attempt_number"),
	CONSTRAINT "report_pdf_attempt_number" CHECK ("report_pdf_attempts"."attempt_number" between 1 and 5),
	CONSTRAINT "report_pdf_attempt_state" CHECK (("report_pdf_attempts"."status"='running' and "report_pdf_attempts"."completed_at" is null and "report_pdf_attempts"."error_code" is null and "report_pdf_attempts"."error_message" is null)
    or ("report_pdf_attempts"."status"='succeeded' and "report_pdf_attempts"."completed_at" is not null and "report_pdf_attempts"."error_code" is null and "report_pdf_attempts"."error_message" is null)
    or ("report_pdf_attempts"."status" in ('failed','expired') and "report_pdf_attempts"."completed_at" is not null and "report_pdf_attempts"."error_code" is not null and "report_pdf_attempts"."error_message" is not null and "report_pdf_attempts"."error_code" ~ '^[a-z0-9_]{1,80}$' and length("report_pdf_attempts"."error_message") between 1 and 2000)),
	CONSTRAINT "report_pdf_attempt_dates" CHECK ("report_pdf_attempts"."completed_at" is null or "report_pdf_attempts"."completed_at" >= "report_pdf_attempts"."started_at")
);
--> statement-breakpoint
CREATE TABLE "report_pdf_jobs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"renderer_id" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token_hash" "bytea",
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	CONSTRAINT "report_pdf_jobs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "report_pdf_job_report_key" UNIQUE("organization_id","report_id"),
	CONSTRAINT "report_pdf_job_identity_key" UNIQUE("organization_id","id","report_id"),
	CONSTRAINT "report_pdf_job_version" CHECK ("report_pdf_jobs"."renderer_id" ~ '^[a-f0-9]{64}$' and "report_pdf_jobs"."attempts" between 0 and 5),
	CONSTRAINT "report_pdf_job_state" CHECK (("report_pdf_jobs"."status"='queued' and "report_pdf_jobs"."lease_token_hash" is null and "report_pdf_jobs"."lease_expires_at" is null and "report_pdf_jobs"."completed_at" is null)
    or ("report_pdf_jobs"."status"='running' and "report_pdf_jobs"."attempts">0 and "report_pdf_jobs"."lease_token_hash" is not null and octet_length("report_pdf_jobs"."lease_token_hash")=32 and "report_pdf_jobs"."lease_expires_at" is not null and "report_pdf_jobs"."started_at" is not null and "report_pdf_jobs"."lease_expires_at">"report_pdf_jobs"."started_at" and "report_pdf_jobs"."completed_at" is null)
    or ("report_pdf_jobs"."status" in ('succeeded','failed') and "report_pdf_jobs"."attempts">0 and "report_pdf_jobs"."lease_token_hash" is null and "report_pdf_jobs"."lease_expires_at" is null and "report_pdf_jobs"."started_at" is not null and "report_pdf_jobs"."completed_at" is not null)),
	CONSTRAINT "report_pdf_job_dates" CHECK ("report_pdf_jobs"."available_at" >= "report_pdf_jobs"."requested_at" and ("report_pdf_jobs"."started_at" is null or "report_pdf_jobs"."started_at" >= "report_pdf_jobs"."requested_at")
    and ("report_pdf_jobs"."completed_at" is null or "report_pdf_jobs"."completed_at" >= "report_pdf_jobs"."requested_at")),
	CONSTRAINT "report_pdf_job_error" CHECK (("report_pdf_jobs"."last_error_code" is null and "report_pdf_jobs"."last_error_message" is null and "report_pdf_jobs"."status"<>'failed')
    or ("report_pdf_jobs"."last_error_code" is not null and "report_pdf_jobs"."last_error_message" is not null and "report_pdf_jobs"."last_error_code" ~ '^[a-z0-9_]{1,80}$' and length("report_pdf_jobs"."last_error_message") between 1 and 2000 and "report_pdf_jobs"."status"<>'succeeded'))
);
--> statement-breakpoint
ALTER TABLE "report_pdf_artifacts" ADD CONSTRAINT "report_pdf_artifact_job_fk" FOREIGN KEY ("organization_id","job_id","report_id") REFERENCES "public"."report_pdf_jobs"("organization_id","id","report_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdf_artifacts" ADD CONSTRAINT "report_pdf_artifact_attempt_fk" FOREIGN KEY ("organization_id","job_id","attempt_number") REFERENCES "public"."report_pdf_attempts"("organization_id","job_id","attempt_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdf_attempts" ADD CONSTRAINT "report_pdf_attempt_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."report_pdf_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdf_jobs" ADD CONSTRAINT "report_pdf_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdf_jobs" ADD CONSTRAINT "report_pdf_job_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."sample_reports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pdf_jobs" ADD CONSTRAINT "report_pdf_job_requester_fk" FOREIGN KEY ("organization_id","requested_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_pdf_job_ready_idx" ON "report_pdf_jobs" USING btree ("renderer_id","status","available_at","lease_expires_at") WHERE "report_pdf_jobs"."status" in ('queued','running');
