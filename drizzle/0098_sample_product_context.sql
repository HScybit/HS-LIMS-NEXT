-- Runtime readers may see only Product history actually bound to a sample.
-- A PDF worker additionally needs its live lease and is limited to that sample.
CREATE FUNCTION laboratory_product_context_scope() RETURNS TABLE(organization_id uuid,sample_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; selected_sample uuid;
BEGIN
  IF session_user NOT IN ('sampleify_app','sampleify_report_worker') THEN RETURN; END IF;
  org:=nullif(current_setting('app.organization_id',true),'')::uuid;
  PERFORM 1 FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
    JOIN public.organizations organization ON organization.id=membership.organization_id
    WHERE membership.organization_id=org AND membership.user_id=nullif(current_setting('app.user_id',true),'')::uuid
      AND membership.active AND person.active AND organization.active;
  IF NOT FOUND THEN RETURN; END IF;
  IF session_user='sampleify_app' THEN
    IF org IS NOT NULL AND public.laboratory_can_read() THEN RETURN QUERY SELECT org,NULL::uuid; END IF;
  ELSIF session_user='sampleify_report_worker' THEN
    org:=public.report_pdf_context_org();
    IF org IS NULL THEN RETURN; END IF;
    SELECT report.sample_id INTO selected_sample FROM public.report_pdf_jobs job
      JOIN public.sample_reports report ON report.organization_id=job.organization_id AND report.id=job.report_id
      WHERE job.organization_id=org AND job.id=nullif(current_setting('app.report_pdf_job_id',true),'')::uuid;
    IF selected_sample IS NOT NULL
      AND (public.app_has_permission('samples.read') OR public.app_has_permission('samples.manage'))
      AND public.report_can_print(selected_sample) THEN RETURN QUERY SELECT org,selected_sample; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION laboratory_product_context_scope() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION laboratory_product_context_scope() TO sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE VIEW laboratory_product_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_product_context_scope())
SELECT line.organization_id,line.sample_id,line.id AS sample_product_id,line.display_order,line.product_id,line.product_revision,
  version.revision IS NOT NULL AS history_available,coalesce(version.code,line.product_code) AS code,coalesce(version.name,line.product_name) AS name,
  version.description,version.abbreviation,version.job_template_id,version.tag_count,
  ARRAY(SELECT tag.tag_id FROM public.product_version_tags tag WHERE tag.organization_id=line.organization_id
    AND tag.product_id=line.product_id AND tag.revision=line.product_revision ORDER BY tag.position) AS tag_ids,
  version.custom_field_count,
  (SELECT count(*)::integer FROM public.product_version_custom_fields field WHERE field.organization_id=line.organization_id
    AND field.product_id=line.product_id AND field.revision=line.product_revision) AS actual_field_count,
  created.saved_at AS created_at,created.saved_by AS created_by,
  CASE WHEN version.operation='update' THEN version.saved_at END AS updated_at
FROM scope JOIN public.sample_products line ON line.organization_id=scope.organization_id AND (scope.sample_id IS NULL OR line.sample_id=scope.sample_id)
LEFT JOIN public.product_versions version ON version.organization_id=line.organization_id AND version.product_id=line.product_id AND version.revision=line.product_revision
LEFT JOIN public.product_versions created ON created.organization_id=line.organization_id AND created.product_id=line.product_id
  AND created.revision=1 AND created.operation='create' AND line.product_revision IS NOT NULL;
--> statement-breakpoint
CREATE VIEW laboratory_product_field_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_product_context_scope())
SELECT line.organization_id,line.sample_id,line.id AS sample_product_id,line.product_id,line.product_revision,
  field.field_id,field.field_revision,field.field_type,field.position,field.is_array,field.value_count,
  field.display_kind,field.display_text,field.display_number,field.display_boolean,definition.key AS field_key,definition.label
FROM scope JOIN public.sample_products line ON line.organization_id=scope.organization_id AND (scope.sample_id IS NULL OR line.sample_id=scope.sample_id)
JOIN public.product_version_custom_fields field ON field.organization_id=line.organization_id AND field.product_id=line.product_id AND field.revision=line.product_revision
JOIN public.custom_field_versions definition ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision;
--> statement-breakpoint
CREATE VIEW laboratory_product_value_context WITH (security_barrier=true,security_invoker=false) AS
SELECT field.organization_id,field.sample_id,field.sample_product_id,field.product_id,field.product_revision,field.field_key,
  item.field_id,item.position,item.raw_kind,item.raw_text,item.raw_number,item.raw_boolean
FROM public.laboratory_product_field_context field JOIN public.product_version_custom_field_values item
  ON item.organization_id=field.organization_id AND item.product_id=field.product_id AND item.revision=field.product_revision AND item.field_id=field.field_id;
REVOKE ALL ON laboratory_product_context,laboratory_product_field_context,laboratory_product_value_context FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_product_context,laboratory_product_field_context,laboratory_product_value_context TO sampleify_app,sampleify_report_worker;
