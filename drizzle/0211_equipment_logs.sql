-- Step 10d: Equipment service/breakdown logs against the already-built
-- Instrument master. Current-state logs, matching Meteor/PERN (no approval
-- workflow, no versioned history) — same precedent as 0209/0210. Reuses
-- instruments.read for viewing (matching PERN); adds instrument_services.manage
-- for writing, also matching PERN's own separate permission for this.
INSERT INTO permissions(code,description) VALUES
  ('instrument_services.manage','Manage instrument service and breakdown logs')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE instrument_service_logs (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL,
  service_code text NOT NULL,
  service_date date NOT NULL,
  next_service_on date,
  summary text NOT NULL,
  details text,
  vendor_id uuid,
  vendor_name text,
  cost numeric,
  calibration_type text,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT instrument_service_logs_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT instrument_service_log_instrument_fk FOREIGN KEY(organization_id,instrument_id) REFERENCES instruments(organization_id,id),
  CONSTRAINT instrument_service_log_vendor_fk FOREIGN KEY(organization_id,vendor_id) REFERENCES vendors(organization_id,id),
  CONSTRAINT instrument_service_log_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT instrument_service_log_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT instrument_service_log_fields CHECK (length(trim(service_code)) BETWEEN 1 AND 64 AND length(trim(summary)) BETWEEN 1 AND 500
    AND (details IS NULL OR length(details) BETWEEN 1 AND 10000)
    AND (next_service_on IS NULL OR next_service_on >= service_date)
    AND (cost IS NULL OR (cost >= 0 AND cost NOT IN ('NaN','Infinity','-Infinity')))
    AND (calibration_type IS NULL OR length(trim(calibration_type)) BETWEEN 1 AND 100)
    AND revision > 0)
);
CREATE INDEX instrument_service_log_listing ON instrument_service_logs(organization_id,instrument_id,service_date,id);
CREATE TABLE instrument_breakdown_logs (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL,
  breakdown_date date NOT NULL,
  summary text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open',
  resolved_on date,
  resolution_vendor_id uuid,
  resolution_vendor_name text,
  resolution_cost numeric,
  resolution_comments text,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT instrument_breakdown_logs_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT instrument_breakdown_log_instrument_fk FOREIGN KEY(organization_id,instrument_id) REFERENCES instruments(organization_id,id),
  CONSTRAINT instrument_breakdown_log_vendor_fk FOREIGN KEY(organization_id,resolution_vendor_id) REFERENCES vendors(organization_id,id),
  CONSTRAINT instrument_breakdown_log_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT instrument_breakdown_log_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT instrument_breakdown_log_fields CHECK (length(trim(summary)) BETWEEN 1 AND 500 AND (details IS NULL OR length(details) BETWEEN 1 AND 10000)
    AND status IN ('open','resolved') AND revision > 0
    AND (status='open' AND resolved_on IS NULL AND resolution_vendor_id IS NULL AND resolution_vendor_name IS NULL
        AND resolution_cost IS NULL AND resolution_comments IS NULL
      OR status='resolved' AND resolved_on IS NOT NULL AND resolved_on >= breakdown_date
        AND (resolution_vendor_id IS NOT NULL OR resolution_vendor_name IS NOT NULL)
        AND resolution_cost IS NOT NULL AND resolution_cost >= 0 AND resolution_cost NOT IN ('NaN','Infinity','-Infinity')
        AND resolution_comments IS NOT NULL AND length(trim(resolution_comments)) BETWEEN 1 AND 10000))
);
CREATE INDEX instrument_breakdown_log_listing ON instrument_breakdown_logs(organization_id,instrument_id,breakdown_date,id);
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['instrument_service_logs','instrument_breakdown_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY instrument_log_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''instruments.read'') OR app_has_permission(''instrument_services.manage'')))',relation);
    EXECUTE format('CREATE POLICY instrument_log_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''instrument_services.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''instrument_services.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
