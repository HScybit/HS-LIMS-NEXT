-- Step 10b: Leave Management. A flat operational log, matching Meteor/PERN's
-- own treatment (no approval workflow, no versioned history) — current-state
-- only, following the step-7 organization-settings-child-table pattern
-- rather than the versioned-snapshot machinery used for regulated masters.
INSERT INTO permissions(code,description) VALUES
  ('leave_records.read','View leave records'),('leave_records.manage','Manage leave records')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE leave_record_attachments (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  original_name text NOT NULL,
  media_type text NOT NULL,
  content bytea NOT NULL,
  byte_length integer NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT leave_record_attachment_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT leave_record_attachment_actor_fk FOREIGN KEY(organization_id,uploaded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT leave_record_attachment_fields CHECK (length(original_name) BETWEEN 1 AND 500 AND original_name=trim(original_name)
    AND original_name !~ '[[:cntrl:]]' AND position('/' IN original_name)=0 AND position(chr(92) IN original_name)=0
    AND length(media_type) BETWEEN 1 AND 255 AND media_type=lower(media_type)
    AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    AND byte_length BETWEEN 0 AND 26214400 AND byte_length=octet_length(content) AND sha256=encode(sha256(content),'hex'))
);
CREATE TABLE leave_records (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  remark text,
  attachment_id uuid,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT leave_records_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT leave_record_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT leave_record_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT leave_record_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT leave_record_attachment_fk FOREIGN KEY(organization_id,attachment_id) REFERENCES leave_record_attachments(organization_id,id),
  CONSTRAINT leave_record_dates CHECK (to_date >= from_date AND revision > 0 AND (remark IS NULL OR length(remark) BETWEEN 1 AND 5000))
);
CREATE INDEX leave_record_listing ON leave_records(organization_id,from_date,id);
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['leave_records','leave_record_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY leave_record_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''leave_records.read'') OR app_has_permission(''leave_records.manage'')))',relation);
    EXECUTE format('CREATE POLICY leave_record_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''leave_records.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''leave_records.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
