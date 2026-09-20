-- Approval readers need the same pinned template definition as the datasheet.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['templates', 'template_versions', 'template_sections', 'template_rows',
    'template_columns', 'template_fields', 'template_numeric_config', 'template_options',
    'template_expressions', 'template_expression_nodes', 'template_repeat_groups'] LOOP
    EXECUTE format('ALTER POLICY definition_read ON %I USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
      (SELECT public.app_has_permission(''templates.read'') OR public.app_has_permission(''templates.manage'')
        OR public.app_has_permission(''datasheets.execute'') OR public.app_has_permission(''test_requests.allocate'')
        OR public.app_has_permission(''samples.manage'') OR public.app_has_permission(''samples.read'')
        OR public.app_has_permission(''approvals.respond'')))', relation);
  END LOOP;
END $$;
