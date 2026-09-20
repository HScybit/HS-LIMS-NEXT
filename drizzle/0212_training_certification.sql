-- Step 10f: Training Schedules, Attendance and User Certification.
-- Current-state records (no approval workflow, no versioned history), same
-- precedent as 0209/0210/0211. Meteor's ActualTraining/Templatizer
-- document-rendering integration is deliberately not carried over —
-- scheduling/attendance/certification tracking is the load-bearing part;
-- there is no "training" template kind scaffolded anywhere in this
-- codebase to render against, unlike e.g. equipment_service_log.
INSERT INTO permissions(code,description) VALUES
  ('training.read','View training schedules, attendance and certifications'),('training.manage','Manage training schedules, attendance and certifications')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE training_schedules (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  from_date date NOT NULL,
  to_date date NOT NULL,
  trainer_name text,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT training_schedules_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT training_schedule_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT training_schedule_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT training_schedule_fields CHECK (length(trim(name)) BETWEEN 1 AND 200 AND (description IS NULL OR length(description) BETWEEN 1 AND 10000)
    AND to_date >= from_date AND (trainer_name IS NULL OR length(trim(trainer_name)) BETWEEN 1 AND 200) AND revision > 0)
);
CREATE INDEX training_schedule_listing ON training_schedules(organization_id,from_date,id);
CREATE TABLE training_schedule_attendees (
  organization_id uuid NOT NULL,
  training_schedule_id uuid NOT NULL,
  user_id uuid NOT NULL,
  CONSTRAINT training_schedule_attendees_pkey PRIMARY KEY(organization_id,training_schedule_id,user_id),
  CONSTRAINT training_schedule_attendee_schedule_fk FOREIGN KEY(organization_id,training_schedule_id) REFERENCES training_schedules(organization_id,id),
  CONSTRAINT training_schedule_attendee_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id)
);
CREATE TABLE training_attendance (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  training_schedule_id uuid NOT NULL,
  user_id uuid NOT NULL,
  attendance_date date NOT NULL,
  check_in_at timestamptz,
  check_out_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT training_attendance_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT training_attendance_schedule_fk FOREIGN KEY(organization_id,training_schedule_id) REFERENCES training_schedules(organization_id,id),
  CONSTRAINT training_attendance_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT training_attendance_actor_fk FOREIGN KEY(organization_id,recorded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT training_attendance_fields CHECK ((check_out_at IS NULL OR check_in_at IS NOT NULL AND check_out_at >= check_in_at) AND revision > 0),
  CONSTRAINT training_attendance_unique UNIQUE(organization_id,training_schedule_id,user_id,attendance_date)
);
CREATE TABLE user_certification_files (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  original_name text NOT NULL,
  media_type text NOT NULL,
  content bytea NOT NULL,
  byte_length integer NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT user_certification_file_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT user_certification_file_actor_fk FOREIGN KEY(organization_id,uploaded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT user_certification_file_fields CHECK (length(original_name) BETWEEN 1 AND 500 AND original_name=trim(original_name)
    AND original_name !~ '[[:cntrl:]]' AND position('/' IN original_name)=0 AND position(chr(92) IN original_name)=0
    AND length(media_type) BETWEEN 1 AND 255 AND media_type=lower(media_type)
    AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    AND byte_length BETWEEN 0 AND 26214400 AND byte_length=octet_length(content) AND sha256=encode(sha256(content),'hex'))
);
CREATE TABLE user_certifications (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method_id uuid,
  certification_name text NOT NULL,
  completion_status text NOT NULL DEFAULT 'pending',
  valid_from date NOT NULL,
  valid_till date,
  certificate_file_id uuid,
  reviewer_id uuid,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT user_certifications_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT user_certification_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT user_certification_reviewer_fk FOREIGN KEY(organization_id,reviewer_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT user_certification_method_fk FOREIGN KEY(organization_id,method_id) REFERENCES methods_of_analysis(organization_id,id),
  CONSTRAINT user_certification_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT user_certification_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT user_certification_file_fk FOREIGN KEY(organization_id,certificate_file_id) REFERENCES user_certification_files(organization_id,id),
  CONSTRAINT user_certification_fields CHECK (length(trim(certification_name)) BETWEEN 1 AND 200 AND completion_status IN ('pending','completed','expired')
    AND (valid_till IS NULL OR valid_till >= valid_from) AND revision > 0)
);
CREATE INDEX user_certification_listing ON user_certifications(organization_id,user_id,valid_from,id);
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['training_schedules','training_schedule_attendees','training_attendance','user_certifications','user_certification_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY training_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''training.read'') OR app_has_permission(''training.manage'')))',relation);
    EXECUTE format('CREATE POLICY training_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''training.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''training.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
