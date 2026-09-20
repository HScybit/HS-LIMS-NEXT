CREATE INDEX "analytical_specification_parameter_version" ON "analytical_specifications" USING btree ("organization_id","test_parameter_id","parameter_revision");
--> statement-breakpoint
CREATE OR REPLACE VIEW laboratory_parameter_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_context_scope())
SELECT specification.organization_id,specification.id AS specification_id,specification.test_parameter_id AS parameter_id,specification.parameter_revision,
  version.revision IS NOT NULL AS history_available,version.description,version.display_order,version.scheme_abbreviation,version.laboratory_id,version.custom_field_count
FROM scope JOIN public.analytical_specifications specification ON specification.organization_id=scope.organization_id
  AND (scope.report_id IS NULL OR EXISTS (SELECT 1 FROM public.sample_report_tests chosen
    WHERE chosen.organization_id=scope.organization_id AND chosen.report_id=scope.report_id AND chosen.specification_id=specification.id))
LEFT JOIN public.test_parameter_versions version ON version.organization_id=specification.organization_id
  AND version.parameter_id=specification.test_parameter_id AND version.revision=specification.parameter_revision;
REVOKE ALL ON laboratory_parameter_context FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_parameter_context TO sampleify_app,sampleify_report_worker;

--> statement-breakpoint
-- A captured parameter/version is exposed once even when many specifications
-- refer to it. Scope retains the exact selected report and its live PDF lease.
CREATE VIEW laboratory_parameter_field_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_context_scope())
SELECT field.organization_id,field.parameter_id,field.revision AS parameter_revision,field.field_id,field.field_revision,
  field.field_type,field.position,field.is_array,field.value_count,field.display_kind,field.display_text,field.display_number,field.display_boolean,
  definition.key AS field_key,definition.label,definition.scheme,definition.padded_number,definition.splitter,definition.date_format,definition.datetime_format
FROM scope JOIN public.parameter_version_custom_fields field ON field.organization_id=scope.organization_id
JOIN public.custom_field_versions definition ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
WHERE EXISTS (SELECT 1 FROM public.analytical_specifications specification
  WHERE specification.organization_id=field.organization_id AND specification.test_parameter_id=field.parameter_id AND specification.parameter_revision=field.revision
    AND (scope.report_id IS NULL OR EXISTS (SELECT 1 FROM public.sample_report_tests chosen
      WHERE chosen.organization_id=scope.organization_id AND chosen.report_id=scope.report_id AND chosen.specification_id=specification.id)));
--> statement-breakpoint
CREATE VIEW laboratory_parameter_value_context WITH (security_barrier=true,security_invoker=false) AS
SELECT field.organization_id,field.parameter_id,field.parameter_revision,field.field_key,item.field_id,item.position,
  item.raw_kind,item.raw_text,item.raw_number,item.raw_boolean
FROM public.laboratory_parameter_field_context field JOIN public.parameter_version_custom_field_values item
  ON item.organization_id=field.organization_id AND item.parameter_id=field.parameter_id AND item.revision=field.parameter_revision AND item.field_id=field.field_id;
REVOKE ALL ON laboratory_parameter_field_context,laboratory_parameter_value_context FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_parameter_field_context,laboratory_parameter_value_context TO sampleify_app,sampleify_report_worker;
