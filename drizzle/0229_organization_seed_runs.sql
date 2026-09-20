CREATE TABLE "seed_runs" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "id" uuid PRIMARY KEY,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "failure_message" text,
  "actor_organization_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  CONSTRAINT "seed_run_mode" CHECK ("mode" IN ('fresh', 'reseed')),
  CONSTRAINT "seed_run_status" CHECK ("status" IN ('running', 'succeeded', 'failed')),
  CONSTRAINT "seed_run_completion" CHECK (("status" = 'running') = ("completed_at" IS NULL)),
  CONSTRAINT "seed_run_failure" CHECK ("failure_message" IS NULL OR "status" = 'failed')
);--> statement-breakpoint
CREATE INDEX "seed_runs_recent" ON "seed_runs" ("organization_id", "started_at" DESC);--> statement-breakpoint

CREATE TABLE "seed_run_steps" (
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "domain_key" text NOT NULL,
  "status" text NOT NULL,
  "message" text,
  "completed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "run_id", "position"),
  FOREIGN KEY ("run_id") REFERENCES "seed_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "seed_run_step_status" CHECK ("status" IN ('succeeded', 'failed'))
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "seed_runs" TO sampleify_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "seed_run_steps" TO sampleify_app;--> statement-breakpoint
ALTER TABLE "seed_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seed_run_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Seeding is a platform-administrator operation, so a run is visible to the
-- organization it targets and to any platform administrator.
CREATE POLICY "seed_run_scope" ON "seed_runs" FOR ALL USING (
  "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid OR auth_is_platform_administrator()
) WITH CHECK (
  "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid OR auth_is_platform_administrator()
);--> statement-breakpoint
CREATE POLICY "seed_run_step_scope" ON "seed_run_steps" FOR ALL USING (
  "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid OR auth_is_platform_administrator()
) WITH CHECK (
  "organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid OR auth_is_platform_administrator()
);
