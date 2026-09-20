-- Step 10f part 2: Assessments (quizzes). Unlike the rest of step 10, this
-- is built from scratch — Meteor's own Assessment/UserAssessment feature
-- has a data model and an unfinished release/clone mechanism but no real
-- scoring logic and no quiz-taking UI anywhere in the reference app. This
-- is a single-question-type (multiple choice, one correct option,
-- auto-scored) quiz rather than an attempt to reproduce Meteor's richer
-- but non-functional "assessment_configs" concept.
INSERT INTO permissions(code,description) VALUES
  ('assessments.read','View assessments and results'),('assessments.manage','Author and assign assessments'),
  ('assessments.take','Take an assigned assessment')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE assessments (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  from_date timestamptz NOT NULL,
  to_date timestamptz NOT NULL,
  time_limit_minutes integer,
  is_released boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT assessments_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT assessment_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT assessment_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT assessment_fields CHECK (length(trim(name)) BETWEEN 1 AND 200 AND (description IS NULL OR length(description) BETWEEN 1 AND 10000)
    AND to_date >= from_date AND (time_limit_minutes IS NULL OR time_limit_minutes BETWEEN 1 AND 1440) AND revision > 0)
);
CREATE INDEX assessment_listing ON assessments(organization_id,from_date,id);
CREATE TABLE assessment_questions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL,
  display_order integer NOT NULL,
  question_text text NOT NULL,
  points integer NOT NULL DEFAULT 1,
  CONSTRAINT assessment_questions_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT assessment_question_assessment_fk FOREIGN KEY(organization_id,assessment_id) REFERENCES assessments(organization_id,id),
  CONSTRAINT assessment_question_order_key UNIQUE(organization_id,assessment_id,display_order),
  CONSTRAINT assessment_question_fields CHECK (length(trim(question_text)) BETWEEN 1 AND 2000 AND points BETWEEN 1 AND 100 AND display_order >= 0)
);
CREATE TABLE assessment_question_options (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL,
  display_order integer NOT NULL,
  option_text text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  CONSTRAINT assessment_question_options_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT assessment_option_question_fk FOREIGN KEY(organization_id,question_id) REFERENCES assessment_questions(organization_id,id),
  CONSTRAINT assessment_option_order_key UNIQUE(organization_id,question_id,display_order),
  CONSTRAINT assessment_option_fields CHECK (length(trim(option_text)) BETWEEN 1 AND 500 AND display_order >= 0)
);
CREATE UNIQUE INDEX assessment_option_single_correct ON assessment_question_options(organization_id,question_id) WHERE is_correct;
CREATE TABLE assessment_assignments (
  organization_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  CONSTRAINT assessment_assignments_pkey PRIMARY KEY(organization_id,assessment_id,user_id),
  CONSTRAINT assessment_assignment_assessment_fk FOREIGN KEY(organization_id,assessment_id) REFERENCES assessments(organization_id,id),
  CONSTRAINT assessment_assignment_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id)
);
CREATE TABLE assessment_attempts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  submitted_at timestamptz,
  total_score integer,
  max_score integer NOT NULL,
  CONSTRAINT assessment_attempts_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT assessment_attempt_assessment_fk FOREIGN KEY(organization_id,assessment_id) REFERENCES assessments(organization_id,id),
  CONSTRAINT assessment_attempt_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT assessment_attempt_key UNIQUE(organization_id,assessment_id,user_id),
  CONSTRAINT assessment_attempt_fields CHECK (max_score >= 0 AND (submitted_at IS NULL AND total_score IS NULL
    OR submitted_at IS NOT NULL AND submitted_at >= started_at AND total_score IS NOT NULL AND total_score BETWEEN 0 AND max_score))
);
CREATE TABLE assessment_answers (
  organization_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  question_id uuid NOT NULL,
  selected_option_id uuid,
  CONSTRAINT assessment_answers_pkey PRIMARY KEY(organization_id,attempt_id,question_id),
  CONSTRAINT assessment_answer_attempt_fk FOREIGN KEY(organization_id,attempt_id) REFERENCES assessment_attempts(organization_id,id),
  CONSTRAINT assessment_answer_question_fk FOREIGN KEY(organization_id,question_id) REFERENCES assessment_questions(organization_id,id),
  CONSTRAINT assessment_answer_option_fk FOREIGN KEY(organization_id,selected_option_id) REFERENCES assessment_question_options(organization_id,id)
);
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['assessments','assessment_questions','assessment_question_options','assessment_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY assessment_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''assessments.read'') OR app_has_permission(''assessments.manage'') OR app_has_permission(''assessments.take'')))',relation);
    EXECUTE format('CREATE POLICY assessment_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''assessments.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''assessments.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['assessment_attempts','assessment_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY assessment_attempt_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''assessments.read'') OR app_has_permission(''assessments.manage'') OR app_has_permission(''assessments.take'')))',relation);
    EXECUTE format('CREATE POLICY assessment_attempt_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''assessments.manage'') OR app_has_permission(''assessments.take'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''assessments.manage'') OR app_has_permission(''assessments.take'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
