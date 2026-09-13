-- A submitted final section retains the datasheet line that was displayed
-- when its results were captured. It does not use the child report's line.
-- Expose only immutable contexts reached by an actual selected section
-- submission; workers must hold the exact report's active print lease.
CREATE FUNCTION report_final_line_contexts(p_report_ids uuid[]) RETURNS TABLE(
  organization_id uuid,report_id uuid,instance_id uuid,datasheet_id uuid,sample_product_id uuid,product_id uuid,sample_category_id uuid,
  product_name text,category_name text,description text,quantity numeric,sample_size text,quality text,identification_mark text,received_condition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user NOT IN ('sampleify_app','sampleify_report_worker') THEN RETURN; END IF;
  IF p_report_ids IS NULL OR cardinality(p_report_ids) NOT BETWEEN 1 AND 1000 OR array_position(p_report_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Select a bounded batch of reports' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_context_scope())
SELECT DISTINCT report.organization_id,report.id AS report_id,submission.instance_id,context.datasheet_id,
  context.sample_product_id,context.product_id,context.sample_category_id,context.product_name,context.category_name,
  context.description,context.quantity,context.sample_size,context.quality,context.identification_mark,context.received_condition
FROM scope JOIN public.sample_reports report ON report.organization_id=scope.organization_id
  AND report.id=ANY(p_report_ids) AND (scope.report_id IS NULL OR report.id=scope.report_id)
JOIN public.sample_report_tests chosen ON chosen.organization_id=report.organization_id AND chosen.report_id=report.id
JOIN public.datasheet_submissions submission ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id AND submission.source='section'
JOIN public.sample_line_contexts context ON context.organization_id=submission.organization_id AND context.datasheet_id=submission.source_datasheet_id
WHERE (public.app_has_permission('samples.read') OR public.app_has_permission('samples.manage')) AND public.report_can_print(report.sample_id);
END $$;
REVOKE ALL ON FUNCTION report_final_line_contexts(uuid[]) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION report_final_line_contexts(uuid[]) TO sampleify_app,sampleify_report_worker;
