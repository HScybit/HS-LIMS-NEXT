-- Step 10g part 1: Document Management System foundation — categories,
-- upload/versioning. Deliberately built WITHOUT Meteor's approval-workflow
-- integration: that would mean extending the shared workflow/approval
-- engine (currently hard-scoped to sample/test_request/instrument_service
-- owner types across workflow_runs' CHECK, workflowStateAccess's dispatch,
-- etc.), a foundational change to already-shipped shared infrastructure
-- that every sample/test-request feature depends on. That deserves a live
-- review, not an unsupervised overnight change — flagged explicitly for
-- that review. This ships a genuinely useful controlled-document library
-- (category access, upload, version chain) now; approval integration is a
-- separate follow-up once that review happens.
INSERT INTO permissions(code,description) VALUES
  ('documents.read','View accessible document categories and documents'),('documents.manage','Manage document categories and documents, with access to all categories')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE document_categories (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  expiry_applicable boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT document_categories_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT document_category_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT document_category_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT document_category_fields CHECK (length(trim(name)) BETWEEN 1 AND 200 AND (description IS NULL OR length(description) BETWEEN 1 AND 10000) AND revision > 0)
);
CREATE TABLE document_category_access (
  organization_id uuid NOT NULL,
  document_category_id uuid NOT NULL,
  user_id uuid NOT NULL,
  CONSTRAINT document_category_access_pkey PRIMARY KEY(organization_id,document_category_id,user_id),
  CONSTRAINT document_category_access_category_fk FOREIGN KEY(organization_id,document_category_id) REFERENCES document_categories(organization_id,id),
  CONSTRAINT document_category_access_user_fk FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id)
);
CREATE TABLE document_files (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  original_name text NOT NULL,
  media_type text NOT NULL,
  content bytea NOT NULL,
  byte_length integer NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT document_file_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT document_file_actor_fk FOREIGN KEY(organization_id,uploaded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT document_file_fields CHECK (length(original_name) BETWEEN 1 AND 500 AND original_name=trim(original_name)
    AND original_name !~ '[[:cntrl:]]' AND position('/' IN original_name)=0 AND position(chr(92) IN original_name)=0
    AND length(media_type) BETWEEN 1 AND 255 AND media_type=lower(media_type)
    AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    AND byte_length BETWEEN 0 AND 26214400 AND byte_length=octet_length(content) AND sha256=encode(sha256(content),'hex'))
);
CREATE TABLE documents (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  document_category_id uuid NOT NULL,
  file_id uuid NOT NULL,
  parent_document_id uuid,
  version_label text,
  is_latest boolean NOT NULL DEFAULT true,
  expiry_date date,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT documents_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT document_category_fk FOREIGN KEY(organization_id,document_category_id) REFERENCES document_categories(organization_id,id),
  CONSTRAINT document_file_fk FOREIGN KEY(organization_id,file_id) REFERENCES document_files(organization_id,id),
  CONSTRAINT document_parent_fk FOREIGN KEY(organization_id,parent_document_id) REFERENCES documents(organization_id,id),
  CONSTRAINT document_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT document_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT document_fields CHECK (length(trim(name)) BETWEEN 1 AND 200 AND (description IS NULL OR length(description) BETWEEN 1 AND 10000)
    AND (version_label IS NULL OR length(trim(version_label)) BETWEEN 1 AND 100) AND parent_document_id IS DISTINCT FROM id AND revision > 0)
);
CREATE INDEX document_category_listing ON documents(organization_id,document_category_id,created_at,id);
--> statement-breakpoint
-- Read access is category-scoped for plain documents.read holders (mirroring
-- Meteor's own has_access allow-list): they see only categories/documents/
-- files they are explicitly granted; documents.manage bypasses this and
-- sees everything (the "org admin" tier). document_category_access itself
-- is manage-only to browse in full, but every actor may always see their
-- own grant row, since the application layer needs that to answer "can I
-- see this category" for a plain documents.read holder.
ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY document_category_read ON document_categories FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (
    (SELECT app_has_permission('documents.manage'))
    OR ((SELECT app_has_permission('documents.read')) AND EXISTS (SELECT 1 FROM document_category_access access
      WHERE access.organization_id=document_categories.organization_id AND access.document_category_id=document_categories.id
        AND access.user_id=nullif(current_setting('app.user_id',true),'')::uuid))
  ));
CREATE POLICY document_category_write ON document_categories FOR ALL TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('documents.manage')))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('documents.manage')));
GRANT SELECT,INSERT,UPDATE,DELETE ON document_categories TO sampleify_app;

ALTER TABLE document_category_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_category_access FORCE ROW LEVEL SECURITY;
CREATE POLICY document_category_access_read ON document_category_access FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND ((SELECT app_has_permission('documents.manage')) OR user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY document_category_access_write ON document_category_access FOR ALL TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('documents.manage')))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('documents.manage')));
GRANT SELECT,INSERT,UPDATE,DELETE ON document_category_access TO sampleify_app;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY document_read ON documents FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (
    (SELECT app_has_permission('documents.manage'))
    OR ((SELECT app_has_permission('documents.read')) AND EXISTS (SELECT 1 FROM document_category_access access
      WHERE access.organization_id=documents.organization_id AND access.document_category_id=documents.document_category_id
        AND access.user_id=nullif(current_setting('app.user_id',true),'')::uuid))
  ));
-- Uploading a new document/version is allowed to any actor who can already
-- see that category (matching Meteor: regular staff with category access
-- create documents; only category configuration itself is admin-only).
CREATE POLICY document_write ON documents FOR ALL TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (
    (SELECT app_has_permission('documents.manage'))
    OR ((SELECT app_has_permission('documents.read')) AND EXISTS (SELECT 1 FROM document_category_access access
      WHERE access.organization_id=documents.organization_id AND access.document_category_id=documents.document_category_id
        AND access.user_id=nullif(current_setting('app.user_id',true),'')::uuid))
  ))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (
    (SELECT app_has_permission('documents.manage'))
    OR ((SELECT app_has_permission('documents.read')) AND EXISTS (SELECT 1 FROM document_category_access access
      WHERE access.organization_id=documents.organization_id AND access.document_category_id=documents.document_category_id
        AND access.user_id=nullif(current_setting('app.user_id',true),'')::uuid))
  ));
GRANT SELECT,INSERT,UPDATE,DELETE ON documents TO sampleify_app;

ALTER TABLE document_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_files FORCE ROW LEVEL SECURITY;
-- An uploader can always see their own upload (including via INSERT...
-- RETURNING immediately after uploading, before any document references it
-- yet — Postgres requires a RETURNING row to also satisfy the table's
-- SELECT policy, and a fresh upload has no category linkage to check yet).
-- Category-scoped visibility governs everyone else's reads.
CREATE POLICY document_file_read ON document_files FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (
    (SELECT app_has_permission('documents.manage'))
    OR uploaded_by=nullif(current_setting('app.user_id',true),'')::uuid
    OR ((SELECT app_has_permission('documents.read')) AND EXISTS (SELECT 1 FROM documents doc JOIN document_category_access access
      ON access.organization_id=doc.organization_id AND access.document_category_id=doc.document_category_id
        AND access.user_id=nullif(current_setting('app.user_id',true),'')::uuid
      WHERE doc.organization_id=document_files.organization_id AND doc.file_id=document_files.id))
  ));
-- A file is uploaded before the document row referencing it exists, so this
-- cannot check document_category_access via a join the way document_read
-- does; any documents.read or documents.manage holder may upload bytes
-- (the documents insert immediately after is what's actually category-
-- scoped, and an orphaned upload with no document referencing it is inert).
-- Scoped to INSERT only (not ALL): a permissive ALL policy would also apply
-- to SELECT and, being OR'd with document_file_read, would silently widen
-- read access to every documents.read holder regardless of category.
CREATE POLICY document_file_write ON document_files FOR INSERT TO sampleify_app
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT app_has_permission('documents.manage') OR app_has_permission('documents.read')));
GRANT SELECT,INSERT ON document_files TO sampleify_app;
