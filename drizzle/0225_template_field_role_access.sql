-- Template Studio parity, Phase 1 (schema/backend): a field can be restricted to
-- specific roles for editing and/or viewing (an empty set means unrestricted, matching
-- PERN's editRoleIds/viewRoleIds). Edit and view share one table (an "access"
-- discriminator) rather than two separate join tables, so loading a template
-- definition costs one more query total instead of two.
CREATE TABLE template_field_role_access (
  organization_id uuid NOT NULL,
  version_id uuid NOT NULL,
  field_id uuid NOT NULL,
  role_id uuid NOT NULL,
  access text NOT NULL,
  PRIMARY KEY (organization_id, version_id, field_id, role_id, access),
  FOREIGN KEY (organization_id, version_id, field_id) REFERENCES template_fields(organization_id, version_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id),
  CHECK (access IN ('edit', 'view'))
);
CREATE TRIGGER definition_guard BEFORE INSERT OR DELETE OR UPDATE ON template_field_role_access FOR EACH ROW EXECUTE FUNCTION template_guard_definition();
-- Same grant + RLS shape as every other per-field template definition table (e.g. template_options):
-- read requires any permission that can reach a template's definition, write requires templates.manage.
GRANT SELECT, INSERT, UPDATE, DELETE ON template_field_role_access TO sampleify_app;
ALTER TABLE template_field_role_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY definition_read ON template_field_role_access FOR SELECT TO sampleify_app USING (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  AND (SELECT app_has_permission('templates.read') OR app_has_permission('templates.manage') OR app_has_permission('datasheets.execute')
    OR app_has_permission('test_requests.allocate') OR app_has_permission('samples.manage') OR app_has_permission('samples.read') OR app_has_permission('approvals.respond'))
);
CREATE POLICY definition_write ON template_field_role_access FOR ALL TO sampleify_app USING (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('templates.manage'))
) WITH CHECK (
  organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('templates.manage'))
);
GRANT SELECT ON template_field_role_access TO sampleify_report_worker;
CREATE POLICY report_worker_read ON template_field_role_access FOR SELECT TO sampleify_report_worker USING (
  organization_id = (SELECT report_pdf_context_org())
);
