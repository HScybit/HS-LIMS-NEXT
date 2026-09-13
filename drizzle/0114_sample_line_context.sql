CREATE TABLE "sample_line_contexts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"datasheet_id" uuid,
	"report_id" uuid,
	"sample_product_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"category_name" text NOT NULL,
	"description" text,
	"quantity" numeric NOT NULL,
	"sample_size" text,
	"quality" text,
	"identification_mark" text,
	"received_condition" text,
	CONSTRAINT "sample_line_context_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "sample_line_datasheet_key" UNIQUE("organization_id","datasheet_id"),
	CONSTRAINT "sample_line_report_key" UNIQUE("organization_id","report_id"),
	CONSTRAINT "sample_line_owner" CHECK (num_nonnulls("sample_line_contexts"."datasheet_id","sample_line_contexts"."report_id")=1),
	CONSTRAINT "sample_line_text_size" CHECK (length("sample_line_contexts"."product_name")<=16000 and length("sample_line_contexts"."category_name")<=16000
    and ("sample_line_contexts"."description" is null or length("sample_line_contexts"."description")<=16000) and ("sample_line_contexts"."sample_size" is null or length("sample_line_contexts"."sample_size")<=16000)
    and ("sample_line_contexts"."quality" is null or length("sample_line_contexts"."quality")<=16000) and ("sample_line_contexts"."identification_mark" is null or length("sample_line_contexts"."identification_mark")<=16000)
    and ("sample_line_contexts"."received_condition" is null or length("sample_line_contexts"."received_condition")<=16000)),
	CONSTRAINT "sample_line_quantity" CHECK ("sample_line_contexts"."quantity">0 and "sample_line_contexts"."quantity" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) and length("sample_line_contexts"."quantity"::text)<=16000)
);
--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_widget_type";--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_field_context";--> statement-breakpoint
ALTER TABLE "template_fields" ADD COLUMN "attribute_key" text;--> statement-breakpoint
ALTER TABLE "sample_line_contexts" ADD CONSTRAINT "sample_line_contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_line_contexts" ADD CONSTRAINT "sample_line_datasheet_fk" FOREIGN KEY ("organization_id","datasheet_id") REFERENCES "public"."datasheets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_line_contexts" ADD CONSTRAINT "sample_line_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."sample_reports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_line_contexts" ADD CONSTRAINT "sample_line_source_fk" FOREIGN KEY ("organization_id","sample_product_id") REFERENCES "public"."sample_products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_line_contexts" ADD CONSTRAINT "sample_line_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_line_contexts" ADD CONSTRAINT "sample_line_category_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_attribute_key" CHECK ("template_fields"."attribute_key" is null or ("template_fields"."widget"='sample_line_item_data_widget' and length("template_fields"."attribute_key")<=16000));--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'vertical_text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'product_detail_widget', 'sample_line_item_data_widget', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'result_widget' and "template_fields"."value_type" in ('numeric', 'result')) or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option') or ("template_fields"."widget" = 'template_image_widget' and "template_fields"."value_type" = 'image') or ("template_fields"."widget"='parameter_detail_widget' and "template_fields"."value_type"='parameter_detail'));--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_field_context" CHECK (("template_fields"."source_field" is null or
    ("template_fields"."widget" = 'sample_line_item_data_widget' and "template_fields"."source_field" in ('custom_category','custom_product','custom_description','custom_sample_quantity','custom_sample_size','custom_quality','custom_indentification_mark','custom_condition')) or
    ("template_fields"."widget" = 'sample_details_widget_v2' and "template_fields"."source_field" in ('sampleNumber', 'customerName', 'customerAddress', 'sampleCategoryName', 'productName', 'receivedAt', 'registeredAt', 'dueAt', 'description', 'customerReference')) or
    ("template_fields"."widget" = 'tr_data_widget' and "template_fields"."source_field" in ('requestNumber', 'parameterName', 'productName', 'methodName', 'analystName', 'submittedAt', 'completedAt')) or
    ("template_fields"."widget" = 'decision_rule_widget' and "template_fields"."source_field" in ('specification', 'measurementUnit', 'parameterName', 'productName', 'methodName', 'decisionOutcome')))
    and ("template_fields"."serial_padding" is null or ("template_fields"."widget" = 'sno_widget' and "template_fields"."serial_padding" between 0 and 100))
    and ("template_fields"."widget" not in ('sample_details_widget_v2', 'product_detail_widget', 'sample_line_item_data_widget', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') or not "template_fields"."editable"));
--> statement-breakpoint
-- Only actual consumer creation can capture a line. No old record is assigned
-- a current value. Master names are observed at that same creation statement,
-- matching the source lookup while retaining immutable historical output.
CREATE FUNCTION sample_line_snapshot_datasheet() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.template_instances capture JOIN public.template_fields field
    ON field.organization_id=capture.organization_id AND field.version_id=capture.version_id
    WHERE capture.organization_id=NEW.organization_id AND capture.id=NEW.template_instance_id AND field.widget='sample_line_item_data_widget') THEN RETURN NULL; END IF;
  INSERT INTO public.sample_line_contexts(organization_id,datasheet_id,sample_product_id,product_id,sample_category_id,
    product_name,category_name,description,quantity,sample_size,quality,identification_mark,received_condition)
  SELECT NEW.organization_id,NEW.id,line.id,line.product_id,line.sample_category_id,product.name,category.name,
    line.description,line.quantity,line.sample_size,line.quality,line.identification_mark,line.received_condition
  FROM public.test_requests request LEFT JOIN public.sample_tests test ON test.organization_id=request.organization_id AND test.id=request.sample_test_id
  JOIN public.sample_products line ON line.organization_id=request.organization_id AND line.id=coalesce(request.job_sample_product_id,test.sample_product_id)
  JOIN public.products product ON product.organization_id=line.organization_id AND product.id=line.product_id
  JOIN public.sample_categories category ON category.organization_id=line.organization_id AND category.id=line.sample_category_id
  WHERE request.organization_id=NEW.organization_id AND request.id=NEW.test_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The datasheet line context is unavailable' USING ERRCODE='23514',CONSTRAINT='sample_line_context_missing'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sample_line_capture_datasheet AFTER INSERT ON datasheets FOR EACH ROW EXECUTE FUNCTION sample_line_snapshot_datasheet();
REVOKE ALL ON FUNCTION sample_line_snapshot_datasheet() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION sample_line_snapshot_reports(p_report_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF session_user<>'sampleify_app' OR org IS NULL OR actor IS NULL OR NOT public.app_has_permission('samples.manage')
    OR NOT EXISTS (SELECT 1 FROM public.laboratory_parameter_context_scope()) THEN
    RAISE EXCEPTION 'Report generation permission required' USING ERRCODE='42501';
  END IF;
  IF p_report_ids IS NULL OR cardinality(p_report_ids) NOT BETWEEN 1 AND 1000
    OR cardinality(p_report_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_report_ids) selected(id)) THEN
    RAISE EXCEPTION 'Select distinct reports from this generation' USING ERRCODE='23514';
  END IF;
  -- Reuse the existing report creation boundary, including its current
  -- transaction, actor, timestamp and print authority. This is not a late
  -- history repair or a way to attach values to an earlier report.
  IF (SELECT count(*) FROM public.sample_reports report WHERE report.organization_id=org AND report.id=ANY(p_report_ids)
    AND report.generated_by=actor AND report.generated_at=now() AND report.xmin::text=pg_current_xact_id()::text
    AND public.report_can_print(report.sample_id))<>cardinality(p_report_ids) THEN
    RAISE EXCEPTION 'Line contexts must belong to this report generation' USING ERRCODE='23514',CONSTRAINT='sample_line_creation';
  END IF;
  INSERT INTO public.sample_line_contexts(organization_id,report_id,sample_product_id,product_id,sample_category_id,
    product_name,category_name,description,quantity,sample_size,quality,identification_mark,received_condition)
  SELECT org,report.id,line.id,line.product_id,line.sample_category_id,product.name,category.name,
    line.description,line.quantity,line.sample_size,line.quality,line.identification_mark,line.received_condition
  FROM public.sample_reports report
  -- Meteor filters a generated child's lines by Product identity as well as
  -- unique line identity. Thus a selected second line of the same Product can
  -- still display the earlier line. Parameter loops do not change this choice.
  CROSS JOIN LATERAL (SELECT candidate.* FROM public.sample_products candidate
    WHERE candidate.organization_id=org AND candidate.sample_id=report.sample_id AND (
      (report.report_type<>'consolidated' AND (candidate.id=report.sample_product_id OR candidate.product_id=(
        SELECT grouped.product_id FROM public.sample_products grouped WHERE grouped.organization_id=org AND grouped.id=report.sample_product_id)))
      OR (report.report_type='consolidated' AND EXISTS (
        SELECT 1 FROM public.sample_products requested_line JOIN public.sample_tests test
          ON test.organization_id=requested_line.organization_id AND test.sample_product_id=requested_line.id
        JOIN public.test_requests request ON request.organization_id=test.organization_id AND request.sample_test_id=test.id AND NOT request.is_job
        JOIN public.analytical_specifications specification ON specification.organization_id=request.organization_id AND specification.id=request.specification_id
        WHERE requested_line.organization_id=org AND requested_line.sample_id=report.sample_id AND requested_line.product_id=candidate.product_id
          AND EXISTS (SELECT 1 FROM public.sample_report_tests chosen JOIN public.analytical_specifications selected
            ON selected.organization_id=chosen.organization_id AND selected.id=chosen.specification_id
            WHERE chosen.organization_id=org AND chosen.report_id=report.id AND selected.test_parameter_id=specification.test_parameter_id))))
    ORDER BY candidate.display_order,candidate.id LIMIT 1) line
  JOIN public.products product ON product.organization_id=org AND product.id=line.product_id
  JOIN public.sample_categories category ON category.organization_id=org AND category.id=line.sample_category_id
  WHERE report.organization_id=org AND report.id=ANY(p_report_ids) AND EXISTS (
    SELECT 1 FROM public.template_fields field WHERE field.organization_id=org AND field.widget='sample_line_item_data_widget'
      AND (field.version_id=report.template_version_id OR EXISTS (
        SELECT 1 FROM public.sample_report_tests chosen JOIN public.datasheet_submissions submission
          ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id AND submission.source='section'
        WHERE chosen.organization_id=org AND chosen.report_id=report.id AND submission.version_id=field.version_id)));
END $$;
REVOKE ALL ON FUNCTION sample_line_snapshot_reports(uuid[]) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION sample_line_snapshot_reports(uuid[]) TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION sample_line_guard_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'Captured line contexts are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER sample_line_immutable BEFORE UPDATE OR DELETE ON sample_line_contexts FOR EACH ROW EXECUTE FUNCTION sample_line_guard_history();
REVOKE ALL ON FUNCTION sample_line_guard_history() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION sample_line_require_report_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_fields field WHERE field.organization_id=NEW.organization_id AND field.widget='sample_line_item_data_widget'
    AND (field.version_id=NEW.template_version_id OR EXISTS (
      SELECT 1 FROM public.sample_report_tests chosen JOIN public.datasheet_submissions submission
        ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id AND submission.source='section'
      WHERE chosen.organization_id=NEW.organization_id AND chosen.report_id=NEW.id AND submission.version_id=field.version_id)))
    AND NOT EXISTS (SELECT 1 FROM public.sample_line_contexts context WHERE context.organization_id=NEW.organization_id AND context.report_id=NEW.id) THEN
    RAISE EXCEPTION 'The report line context is unavailable' USING ERRCODE='23514',CONSTRAINT='sample_line_context_missing';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sample_line_report_complete AFTER INSERT ON sample_reports DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sample_line_require_report_context();
REVOKE ALL ON FUNCTION sample_line_require_report_context() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION sample_line_guard_report_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sample_line_contexts context WHERE context.organization_id=NEW.organization_id AND context.report_id=NEW.report_id) THEN
    RAISE EXCEPTION 'Report selections are already captured' USING ERRCODE='23514',CONSTRAINT='sample_line_report_members';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sample_line_report_members BEFORE INSERT ON sample_report_tests FOR EACH ROW EXECUTE FUNCTION sample_line_guard_report_members();
REVOKE ALL ON FUNCTION sample_line_guard_report_members() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
-- Count active occurrences once at the capture revision boundary, not once
-- per inserted row/widget. Initial allocation and all clone paths are covered
-- before COMMIT, including automatic jobs and alternate methods.
CREATE FUNCTION sample_line_guard_capture_size() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expanded_bytes bigint; capture public.template_instances;
BEGIN
  IF TG_TABLE_NAME='datasheets' THEN
    SELECT * INTO capture FROM public.template_instances WHERE organization_id=NEW.organization_id AND id=NEW.template_instance_id;
  ELSE capture:=NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.template_fields field WHERE field.organization_id=capture.organization_id
    AND field.version_id=capture.version_id AND field.widget='sample_line_item_data_widget') THEN RETURN NULL; END IF;
  SELECT sum(coalesce(octet_length(attribute.value),0)::bigint*occurrences.count) INTO expanded_bytes
  FROM public.datasheets sheet JOIN public.sample_line_contexts context ON context.organization_id=sheet.organization_id AND context.datasheet_id=sheet.id
  CROSS JOIN LATERAL (VALUES ('custom_category',context.category_name),('custom_product',context.product_name),('custom_description',context.description),
    ('custom_sample_quantity',context.quantity::text),('custom_sample_size',context.sample_size),('custom_quality',context.quality),
    ('custom_indentification_mark',context.identification_mark),('custom_condition',context.received_condition)) attribute(key,value)
  JOIN public.template_fields field ON field.organization_id=capture.organization_id AND field.version_id=capture.version_id
    AND field.widget='sample_line_item_data_widget' AND field.source_field=attribute.key
  JOIN (SELECT occurrence.group_id,count(*) AS count FROM public.template_occurrences occurrence
    WHERE occurrence.organization_id=capture.organization_id AND occurrence.instance_id=capture.id AND occurrence.created_revision<=capture.revision
      AND (occurrence.removed_revision IS NULL OR occurrence.removed_revision>capture.revision) GROUP BY occurrence.group_id) occurrences
    ON occurrences.group_id IS NOT DISTINCT FROM field.repeat_group_id
  WHERE sheet.organization_id=capture.organization_id AND sheet.template_instance_id=capture.id;
  IF expanded_bytes>16777216 THEN RAISE EXCEPTION 'The repeated line-item values exceed the supported document size'
    USING ERRCODE='23514',CONSTRAINT='sample_line_size_limit'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sample_line_capture_size AFTER INSERT OR UPDATE ON template_instances DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sample_line_guard_capture_size();
CREATE CONSTRAINT TRIGGER sample_line_datasheet_size AFTER INSERT ON datasheets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sample_line_guard_capture_size();
REVOKE ALL ON FUNCTION sample_line_guard_capture_size() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION template_guard_sample_line_value() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_fields field WHERE field.organization_id=NEW.organization_id
    AND field.version_id=NEW.version_id AND field.id=NEW.field_id AND field.widget='sample_line_item_data_widget') THEN
    RAISE EXCEPTION 'Line-item widgets cannot accept captured values' USING ERRCODE='23514',CONSTRAINT='sample_line_readonly';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_sample_line_value_guard BEFORE INSERT ON template_values FOR EACH ROW EXECUTE FUNCTION template_guard_sample_line_value();
REVOKE ALL ON FUNCTION template_guard_sample_line_value() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
ALTER TABLE sample_line_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_line_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY sample_line_app_read ON sample_line_contexts FOR SELECT TO sampleify_app USING (
  organization_id=(SELECT organization_id FROM laboratory_parameter_context_scope()) AND (
    (datasheet_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.datasheets sheet WHERE sheet.organization_id=sample_line_contexts.organization_id AND sheet.id=sample_line_contexts.datasheet_id))
    OR (report_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.sample_reports report WHERE report.organization_id=sample_line_contexts.organization_id
      AND report.id=sample_line_contexts.report_id AND public.report_can_print(report.sample_id)))));
CREATE POLICY sample_line_worker_read ON sample_line_contexts FOR SELECT TO sampleify_report_worker USING (
  (organization_id,report_id)=(SELECT organization_id,report_id FROM laboratory_parameter_context_scope()));
GRANT SELECT ON sample_line_contexts TO sampleify_app,sampleify_report_worker;
