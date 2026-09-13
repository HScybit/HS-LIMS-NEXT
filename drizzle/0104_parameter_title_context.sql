-- Runtime title metadata is limited to revisions captured by an analytical
-- specification. PDF readers additionally need the exact report's live lease.
CREATE FUNCTION laboratory_parameter_context_scope() RETURNS TABLE(organization_id uuid,report_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; selected_report uuid; selected_sample uuid;
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
    SELECT report.id,report.sample_id INTO selected_report,selected_sample FROM public.report_pdf_jobs job
      JOIN public.sample_reports report ON report.organization_id=job.organization_id AND report.id=job.report_id
      WHERE job.organization_id=org AND job.id=nullif(current_setting('app.report_pdf_job_id',true),'')::uuid;
    IF selected_report IS NOT NULL
      AND (public.app_has_permission('samples.read') OR public.app_has_permission('samples.manage'))
      AND public.report_can_print(selected_sample) THEN RETURN QUERY SELECT org,selected_report; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION laboratory_parameter_context_scope() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION laboratory_parameter_context_scope() TO sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE VIEW laboratory_parameter_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_context_scope())
SELECT specification.organization_id,specification.id AS specification_id,specification.test_parameter_id AS parameter_id,specification.parameter_revision,
  version.revision IS NOT NULL AS history_available,version.description,version.display_order,version.scheme_abbreviation,version.laboratory_id
FROM scope JOIN public.analytical_specifications specification ON specification.organization_id=scope.organization_id
  AND (scope.report_id IS NULL OR EXISTS (SELECT 1 FROM public.sample_report_tests chosen
    WHERE chosen.organization_id=scope.organization_id AND chosen.report_id=scope.report_id AND chosen.specification_id=specification.id))
LEFT JOIN public.test_parameter_versions version ON version.organization_id=specification.organization_id
  AND version.parameter_id=specification.test_parameter_id AND version.revision=specification.parameter_revision;
REVOKE ALL ON laboratory_parameter_context FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_parameter_context TO sampleify_app,sampleify_report_worker;
