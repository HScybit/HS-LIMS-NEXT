-- Registration-only actors may inspect only the actual new automatic child
-- selected by the generation command in this transaction. Existing read and
-- exact-report live-lease boundaries continue to govern every other request.
CREATE FUNCTION laboratory_parameter_read_scope() RETURNS TABLE(organization_id uuid,report_id uuid,specification_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; selected_specification uuid;
BEGIN
  RETURN QUERY SELECT scope.organization_id,scope.report_id,NULL::uuid FROM public.laboratory_parameter_context_scope() scope;
  IF FOUND OR session_user<>'sampleify_app' OR NOT public.app_has_permission('samples.create') THEN RETURN; END IF;
  PERFORM 1 FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
    JOIN public.organizations organization ON organization.id=membership.organization_id
    WHERE membership.organization_id=org AND membership.user_id=nullif(current_setting('app.user_id',true),'')::uuid
      AND membership.active AND person.active AND organization.active;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT request.specification_id INTO selected_specification FROM public.test_requests request
    WHERE request.organization_id=org AND request.id=public.laboratory_auto_job_request();
  IF selected_specification IS NOT NULL THEN RETURN QUERY SELECT org,NULL::uuid,selected_specification; END IF;
END $$;
REVOKE ALL ON FUNCTION laboratory_parameter_read_scope() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION laboratory_parameter_read_scope() TO sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE OR REPLACE VIEW laboratory_parameter_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_read_scope())
SELECT specification.organization_id,specification.id AS specification_id,specification.test_parameter_id AS parameter_id,specification.parameter_revision,
  version.revision IS NOT NULL AS history_available,version.description,version.display_order,version.scheme_abbreviation,version.laboratory_id,version.custom_field_count,specification.parameter_name,specification.parameter_master_key
FROM scope JOIN public.analytical_specifications specification ON specification.organization_id=scope.organization_id
  AND (scope.specification_id IS NULL OR specification.id=scope.specification_id)
  AND (scope.report_id IS NULL OR EXISTS (SELECT 1 FROM public.sample_report_tests chosen
    WHERE chosen.organization_id=scope.organization_id AND chosen.report_id=scope.report_id AND chosen.specification_id=specification.id))
LEFT JOIN public.test_parameter_versions version ON version.organization_id=specification.organization_id
  AND version.parameter_id=specification.test_parameter_id AND version.revision=specification.parameter_revision;
REVOKE ALL ON laboratory_parameter_context FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_parameter_context TO sampleify_app,sampleify_report_worker;

--> statement-breakpoint
CREATE OR REPLACE VIEW laboratory_parameter_field_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_read_scope())
SELECT field.organization_id,field.parameter_id,field.revision AS parameter_revision,field.field_id,field.field_revision,
  field.field_type,field.position,field.is_array,field.value_count,field.display_kind,field.display_text,field.display_number,field.display_boolean,
  definition.key AS field_key,definition.label,definition.scheme,definition.padded_number,definition.splitter,definition.date_format,definition.datetime_format
FROM scope JOIN public.parameter_version_custom_fields field ON field.organization_id=scope.organization_id
JOIN public.custom_field_versions definition ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
WHERE EXISTS (SELECT 1 FROM public.analytical_specifications specification
  WHERE specification.organization_id=field.organization_id AND specification.test_parameter_id=field.parameter_id AND specification.parameter_revision=field.revision
    AND (scope.specification_id IS NULL OR specification.id=scope.specification_id)
    AND (scope.report_id IS NULL OR EXISTS (SELECT 1 FROM public.sample_report_tests chosen
      WHERE chosen.organization_id=scope.organization_id AND chosen.report_id=scope.report_id AND chosen.specification_id=specification.id)));
