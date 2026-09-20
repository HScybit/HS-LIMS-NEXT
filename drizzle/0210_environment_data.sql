-- Step 10c: Environmental Monitoring. Current-state readings, matching
-- Meteor/PERN (no approval workflow, no versioned history) — same precedent
-- as Leave Management (0209).
INSERT INTO permissions(code,description) VALUES
  ('environment_data.read','View environmental monitoring readings'),('environment_data.manage','Manage environmental monitoring readings')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE environment_data (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  laboratory_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  temperature_celsius numeric,
  relative_humidity_percent numeric,
  revision integer NOT NULL DEFAULT 1,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT environment_data_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT environment_data_laboratory_fk FOREIGN KEY(organization_id,laboratory_id) REFERENCES laboratories(organization_id,id),
  CONSTRAINT environment_data_actor_fk FOREIGN KEY(organization_id,recorded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT environment_data_fields CHECK ((temperature_celsius IS NOT NULL OR relative_humidity_percent IS NOT NULL)
    AND (temperature_celsius IS NULL OR (temperature_celsius BETWEEN -100 AND 200 AND temperature_celsius NOT IN ('NaN','Infinity','-Infinity')))
    AND (relative_humidity_percent IS NULL OR (relative_humidity_percent BETWEEN 0 AND 100 AND relative_humidity_percent NOT IN ('NaN','Infinity','-Infinity')))
    AND revision > 0)
);
CREATE INDEX environment_data_listing ON environment_data(organization_id,recorded_at,id);
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['environment_data'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY environment_data_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''environment_data.read'') OR app_has_permission(''environment_data.manage'')))',relation);
    EXECUTE format('CREATE POLICY environment_data_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''environment_data.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''environment_data.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
