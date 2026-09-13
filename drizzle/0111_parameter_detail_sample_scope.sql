ALTER TABLE "sample_reports" ADD COLUMN "sample_parameter_count" integer;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "report_sample_parameter_count" CHECK ("sample_reports"."sample_parameter_count" is null or "sample_reports"."sample_parameter_count" >= 0);
--> statement-breakpoint
-- A job's one selected child is insufficient when the sample has other parameters.
CREATE OR REPLACE FUNCTION template_check_parameter_detail_value() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE bound_specification uuid; sheet public.datasheets; parent_request public.test_requests;
  item_count integer; first_position integer; last_position integer; payload_bytes bigint;
BEGIN
  WITH RECURSIVE ancestors AS (
    SELECT occurrence.id,occurrence.parent_id,0 AS depth FROM public.template_occurrences occurrence
      WHERE occurrence.organization_id=NEW.organization_id AND occurrence.instance_id=NEW.instance_id AND occurrence.id=NEW.occurrence_id
    UNION ALL SELECT parent.id,parent.parent_id,child.depth+1 FROM public.template_occurrences parent JOIN ancestors child ON child.parent_id=parent.id
      WHERE parent.organization_id=NEW.organization_id AND parent.instance_id=NEW.instance_id AND child.depth<64
  ) SELECT subject.specification_id INTO bound_specification FROM ancestors JOIN public.datasheet_subjects subject
    ON subject.organization_id=NEW.organization_id AND subject.instance_id=NEW.instance_id AND subject.occurrence_id=ancestors.id
    ORDER BY ancestors.depth LIMIT 1;
  IF bound_specification IS NULL THEN
    SELECT * INTO sheet FROM public.datasheets WHERE organization_id=NEW.organization_id AND template_instance_id=NEW.instance_id;
    IF sheet.id IS NOT NULL THEN
      SELECT * INTO parent_request FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=sheet.test_request_id;
      IF NOT parent_request.is_job THEN bound_specification:=sheet.specification_id;
      ELSIF (SELECT count(DISTINCT test.test_parameter_id) FROM public.sample_tests test
        JOIN public.sample_products product ON product.organization_id=test.organization_id AND product.id=test.sample_product_id
        JOIN public.sample_products job_product ON job_product.organization_id=product.organization_id AND job_product.sample_id=product.sample_id
        WHERE product.organization_id=NEW.organization_id AND job_product.id=parent_request.job_sample_product_id)=1
        AND (SELECT count(DISTINCT (specification.test_parameter_id,specification.parameter_revision))
        FROM public.test_requests child JOIN public.analytical_specifications specification
          ON specification.organization_id=child.organization_id AND specification.id=child.specification_id
        WHERE child.organization_id=NEW.organization_id AND child.parent_test_request_id=parent_request.id)=1
        AND EXISTS (SELECT 1 FROM public.test_requests child WHERE child.organization_id=NEW.organization_id
          AND child.parent_test_request_id=parent_request.id AND child.specification_id=NEW.parameter_detail_specification_id) THEN
        bound_specification:=NEW.parameter_detail_specification_id;
      END IF;
    END IF;
  END IF;
  IF bound_specification IS NULL OR bound_specification<>NEW.parameter_detail_specification_id THEN
    RAISE EXCEPTION 'Parameter detail must use its captured parameter binding' USING ERRCODE='23514';
  END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(octet_length(coalesce(text_value,number_value::text,boolean_value::text,''))),0)
    INTO item_count,first_position,last_position,payload_bytes FROM public.template_parameter_detail_items
    WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND field_id=NEW.field_id AND occurrence_id=NEW.occurrence_id AND revision=NEW.revision;
  IF item_count<>NEW.parameter_detail_item_count OR (item_count>0 AND (first_position<>0 OR last_position<>item_count-1)) OR payload_bytes>16777216 THEN
    RAISE EXCEPTION 'Parameter detail list must be complete, ordered and bounded' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Capture only observations made by actual generation. Existing reports and
-- imports without this source evidence keep NULL; selected tests cannot infer it.
CREATE FUNCTION report_guard_parameter_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actual_count integer;
BEGIN
  IF session_user='sampleify_app' THEN
    IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NOT public.app_has_permission('samples.manage') OR NOT public.report_can_print(NEW.sample_id) THEN
      RAISE EXCEPTION 'Report generation permission required' USING ERRCODE='42501';
    END IF;
    PERFORM 1 FROM public.samples WHERE organization_id=NEW.organization_id AND id=NEW.sample_id FOR NO KEY UPDATE;
    SELECT count(DISTINCT test.test_parameter_id) INTO actual_count FROM public.sample_tests test JOIN public.sample_products product
      ON product.organization_id=test.organization_id AND product.id=test.sample_product_id
      WHERE product.organization_id=NEW.organization_id AND product.sample_id=NEW.sample_id;
    IF NEW.sample_parameter_count IS NOT NULL AND NEW.sample_parameter_count<>actual_count THEN
      RAISE EXCEPTION 'Capture the whole sample parameter count' USING ERRCODE='23514',CONSTRAINT='report_sample_parameter_count';
    END IF;
    NEW.sample_parameter_count:=actual_count;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_parameter_count_guard BEFORE INSERT ON sample_reports FOR EACH ROW EXECUTE FUNCTION report_guard_parameter_count();
REVOKE ALL ON FUNCTION report_guard_parameter_count() FROM PUBLIC,sampleify_app,sampleify_report_worker;
