-- Permission inputs are transaction-local constants, independent of the row.
-- Scalar subqueries evaluate them once per statement instead of once per joined row.
-- Tenant predicates, non-owner execution and all permission requirements remain enforced.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['templates', 'template_versions', 'template_sections', 'template_rows',
    'template_columns', 'template_fields', 'template_numeric_config', 'template_options',
    'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('ALTER POLICY definition_read ON %I USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
      (SELECT app_has_permission(''templates.read'') OR app_has_permission(''templates.manage'') OR app_has_permission(''datasheets.execute'')))', relation);
    EXECUTE format('ALTER POLICY definition_write ON %I USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''templates.manage'')))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''templates.manage'')))', relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['template_instances', 'template_occurrences', 'template_values'] LOOP
    EXECUTE format('ALTER POLICY capture_scope ON %I USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''datasheets.execute'')))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''datasheets.execute'')))', relation);
  END LOOP;
END $$;
