CREATE TABLE "template_parameter_detail_items" (
	"organization_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"text_value" text,
	"number_value" numeric,
	"boolean_value" boolean,
	CONSTRAINT "template_parameter_detail_item_pk" PRIMARY KEY("organization_id","instance_id","field_id","occurrence_id","revision","position"),
	CONSTRAINT "template_parameter_detail_item_order" CHECK ("template_parameter_detail_items"."position" between 0 and 999),
	CONSTRAINT "template_parameter_detail_item_payload" CHECK (("template_parameter_detail_items"."kind"='null' and num_nonnulls("template_parameter_detail_items"."text_value","template_parameter_detail_items"."number_value","template_parameter_detail_items"."boolean_value")=0)
    or (num_nonnulls("template_parameter_detail_items"."text_value","template_parameter_detail_items"."number_value","template_parameter_detail_items"."boolean_value")=1 and (
      ("template_parameter_detail_items"."kind"='text' and "template_parameter_detail_items"."text_value" is not null and length("template_parameter_detail_items"."text_value")<=16000)
      or ("template_parameter_detail_items"."kind"='numeric' and "template_parameter_detail_items"."number_value" is not null and "template_parameter_detail_items"."number_value"::text not in ('NaN','Infinity','-Infinity'))
      or ("template_parameter_detail_items"."kind"='boolean' and "template_parameter_detail_items"."boolean_value" is not null))))
);
--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_widget_type";--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_field_default";--> statement-breakpoint
ALTER TABLE "template_values" DROP CONSTRAINT "template_value_revision";--> statement-breakpoint
ALTER TABLE "template_values" DROP CONSTRAINT "template_value_payload";--> statement-breakpoint
ALTER TABLE "template_capture_revisions" ADD COLUMN "parameter_detail_request_id" uuid;--> statement-breakpoint
ALTER TABLE "template_capture_revisions" ADD COLUMN "parameter_detail_field_count" integer;--> statement-breakpoint
ALTER TABLE "template_values" ADD COLUMN "parameter_detail_kind" text;--> statement-breakpoint
ALTER TABLE "template_values" ADD COLUMN "parameter_detail_item_count" integer;--> statement-breakpoint
ALTER TABLE "template_values" ADD COLUMN "parameter_detail_specification_id" uuid;--> statement-breakpoint
ALTER TABLE "template_parameter_detail_items" ADD CONSTRAINT "template_parameter_detail_item_value_fk" FOREIGN KEY ("organization_id","instance_id","field_id","occurrence_id","revision") REFERENCES "public"."template_values"("organization_id","instance_id","field_id","occurrence_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_parameter_detail_specification_fk" FOREIGN KEY ("organization_id","parameter_detail_specification_id") REFERENCES "public"."analytical_specifications"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capture_parameter_detail_request" ON "template_capture_revisions" USING btree ("organization_id","parameter_detail_request_id") WHERE "template_capture_revisions"."parameter_detail_request_id" is not null;--> statement-breakpoint
ALTER TABLE "template_capture_revisions" ADD CONSTRAINT "capture_parameter_detail_request_shape" CHECK (("template_capture_revisions"."parameter_detail_request_id" is null and "template_capture_revisions"."parameter_detail_field_count" is null)
    or ("template_capture_revisions"."parameter_detail_request_id" is not null and "template_capture_revisions"."parameter_detail_field_count" is not null and "template_capture_revisions"."parameter_detail_field_count" between 1 and 1000 and "template_capture_revisions"."revision">1 and "template_capture_revisions"."status"='editing'));--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_parameter_detail_readonly" CHECK ("template_fields"."widget"<>'parameter_detail_widget' or not "template_fields"."editable");--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'vertical_text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'product_detail_widget', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'result_widget' and "template_fields"."value_type" in ('numeric', 'result')) or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option') or ("template_fields"."widget" = 'template_image_widget' and "template_fields"."value_type" = 'image') or ("template_fields"."widget"='parameter_detail_widget' and "template_fields"."value_type"='parameter_detail'));--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_field_default" CHECK (("template_fields"."default_state" in ('absent', 'empty') and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date", "template_fields"."default_image_id") = 0) or ("template_fields"."default_state" = 'present' and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date", "template_fields"."default_image_id") = 1 and (("template_fields"."value_type" in ('text', 'result', 'parameter_detail') and "template_fields"."default_text" is not null) or ("template_fields"."value_type" in ('numeric', 'result') and "template_fields"."default_number" is not null and "template_fields"."default_number"::text not in ('NaN', 'Infinity', '-Infinity')) or ("template_fields"."value_type" = 'boolean' and "template_fields"."default_boolean" is not null) or ("template_fields"."value_type" = 'date' and "template_fields"."default_date" is not null) or ("template_fields"."value_type" = 'image' and "template_fields"."default_image_id" is not null))));--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_parameter_detail_value" CHECK (("template_values"."value_type"<>'parameter_detail' and "template_values"."origin"<>'parameter'
      and num_nonnulls("template_values"."parameter_detail_kind","template_values"."parameter_detail_item_count","template_values"."parameter_detail_specification_id")=0)
    or ("template_values"."value_type"='parameter_detail' and "template_values"."origin"='parameter' and "template_values"."parameter_detail_kind" is not null and "template_values"."parameter_detail_item_count" is not null
      and "template_values"."parameter_detail_specification_id" is not null and "template_values"."lexical" is null and "template_values"."state" in ('present','empty') and (
        ("template_values"."parameter_detail_kind"='array' and "template_values"."state"='present' and "template_values"."parameter_detail_item_count" between 0 and 1000
          and num_nonnulls("template_values"."number_value","template_values"."text_value","template_values"."boolean_value","template_values"."date_value","template_values"."option_id","template_values"."image_id")=0)
        or ("template_values"."parameter_detail_item_count"=0 and (
          ("template_values"."parameter_detail_kind"='text' and (("template_values"."state"='empty' and "template_values"."text_value" is null) or ("template_values"."state"='present' and "template_values"."text_value" is not null and length("template_values"."text_value")<=16000)))
          or ("template_values"."parameter_detail_kind"='numeric' and "template_values"."state"='present' and "template_values"."number_value" is not null)
          or ("template_values"."parameter_detail_kind"='boolean' and "template_values"."state"='present' and "template_values"."boolean_value" is not null))))));--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_revision" CHECK ("template_values"."revision" > 0 and "template_values"."origin" in ('entered', 'calculated', 'default', 'parameter'));--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_payload" CHECK ((
    ("template_values"."state" in ('absent', 'empty', 'not_applicable', 'invalid') and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id", "template_values"."image_id") = 0) or
    ("template_values"."state" = 'present' and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id", "template_values"."image_id") = 1 and (
      ("template_values"."value_type" in ('numeric', 'result', 'parameter_detail') and "template_values"."number_value" is not null and "template_values"."number_value"::text not in ('NaN', 'Infinity', '-Infinity')) or
      ("template_values"."value_type" in ('text', 'result', 'parameter_detail') and "template_values"."text_value" is not null) or ("template_values"."value_type" in ('boolean','parameter_detail') and "template_values"."boolean_value" is not null) or
      ("template_values"."value_type" = 'date' and "template_values"."date_value" is not null) or ("template_values"."value_type" = 'option' and "template_values"."option_id" is not null) or ("template_values"."value_type" = 'image' and "template_values"."image_id" is not null)
    )) or ("template_values"."state"='present' and "template_values"."value_type"='parameter_detail' and "template_values"."parameter_detail_kind"='array'
      and num_nonnulls("template_values"."number_value","template_values"."text_value","template_values"."boolean_value","template_values"."date_value","template_values"."option_id","template_values"."image_id")=0))
    and (("template_values"."state" = 'invalid' and "template_values"."error_code" is not null and "template_values"."error_message" is not null) or ("template_values"."state" <> 'invalid' and "template_values"."error_code" is null and "template_values"."error_message" is null)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_require_current_capture_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_revision integer;
BEGIN
  IF TG_TABLE_NAME IN ('template_values','template_parameter_detail_items') THEN selected_revision:=NEW.revision;
  ELSIF TG_OP='INSERT' THEN selected_revision:=NEW.created_revision;
  ELSE selected_revision:=NEW.removed_revision;
  END IF;
  IF session_user='sampleify_app' AND NOT EXISTS (
    SELECT 1 FROM public.template_capture_revisions revision
    WHERE revision.organization_id=NEW.organization_id AND revision.instance_id=NEW.instance_id
      AND revision.revision=selected_revision AND revision.status='editing' AND revision.transaction_id=pg_current_xact_id()
      AND revision.recorded_by=nullif(current_setting('app.user_id',true),'')::uuid
  ) THEN RAISE EXCEPTION 'Capture changes must belong to a revision created by this transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_record_capture_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE detail_request uuid; detail_count integer;
BEGIN
  IF TG_OP='UPDATE' AND NEW.id=nullif(current_setting('app.parameter_detail_capture_id',true),'')::uuid THEN
    detail_request:=nullif(current_setting('app.parameter_detail_request_id',true),'')::uuid;
    detail_count:=nullif(current_setting('app.parameter_detail_field_count',true),'')::integer;
  END IF;
  INSERT INTO public.template_capture_revisions(organization_id,instance_id,revision,status,transaction_id,recorded_by,database_role,recorded_at,
    parameter_detail_request_id,parameter_detail_field_count)
    VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.status,pg_current_xact_id(),
      nullif(current_setting('app.user_id',true),'')::uuid,session_user,transaction_timestamp(),detail_request,detail_count);
  RETURN NULL;
END $$;

--> statement-breakpoint
CREATE FUNCTION template_check_parameter_detail_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF (SELECT count(*) FROM public.template_values value WHERE value.organization_id=NEW.organization_id
    AND value.instance_id=NEW.instance_id AND value.revision=NEW.revision AND value.origin='parameter')<>NEW.parameter_detail_field_count THEN
    RAISE EXCEPTION 'Parameter detail refresh must record every selected field' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER parameter_detail_request_complete AFTER INSERT ON template_capture_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.parameter_detail_request_id IS NOT NULL)
  EXECUTE FUNCTION template_check_parameter_detail_request();

--> statement-breakpoint
-- The source for a cached value must be the occurrence's subject, the concrete
-- datasheet specification, or a job with one unambiguous parameter version.
CREATE FUNCTION template_check_parameter_detail_value() RETURNS trigger
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
      ELSIF (SELECT count(DISTINCT (specification.test_parameter_id,specification.parameter_revision))
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
CREATE CONSTRAINT TRIGGER parameter_detail_value_complete AFTER INSERT ON template_values
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.value_type='parameter_detail')
  EXECUTE FUNCTION template_check_parameter_detail_value();

--> statement-breakpoint
CREATE FUNCTION template_guard_parameter_detail_item() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Parameter detail history is immutable' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.template_values value WHERE value.organization_id=NEW.organization_id AND value.instance_id=NEW.instance_id
    AND value.field_id=NEW.field_id AND value.occurrence_id=NEW.occurrence_id AND value.revision=NEW.revision
    AND value.value_type='parameter_detail' AND value.parameter_detail_kind='array' AND NEW.position<value.parameter_detail_item_count) THEN
    RAISE EXCEPTION 'Parameter detail item requires its captured list value' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parameter_detail_item_guard BEFORE INSERT OR UPDATE OR DELETE ON template_parameter_detail_items
  FOR EACH ROW EXECUTE FUNCTION template_guard_parameter_detail_item();
CREATE TRIGGER parameter_detail_item_revision_guard BEFORE INSERT ON template_parameter_detail_items
  FOR EACH ROW EXECUTE FUNCTION template_require_current_capture_revision();
ALTER TABLE template_parameter_detail_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY parameter_detail_item_read ON template_parameter_detail_items FOR SELECT TO sampleify_app,sampleify_report_worker USING
  (EXISTS (SELECT 1 FROM template_values value WHERE value.organization_id=template_parameter_detail_items.organization_id
    AND value.instance_id=template_parameter_detail_items.instance_id AND value.field_id=template_parameter_detail_items.field_id
    AND value.occurrence_id=template_parameter_detail_items.occurrence_id AND value.revision=template_parameter_detail_items.revision));
CREATE POLICY parameter_detail_item_insert ON template_parameter_detail_items FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM template_values value WHERE value.organization_id=template_parameter_detail_items.organization_id
      AND value.instance_id=template_parameter_detail_items.instance_id AND value.field_id=template_parameter_detail_items.field_id
      AND value.occurrence_id=template_parameter_detail_items.occurrence_id AND value.revision=template_parameter_detail_items.revision));
GRANT SELECT,INSERT ON template_parameter_detail_items TO sampleify_app;
GRANT SELECT ON template_parameter_detail_items TO sampleify_report_worker;
-- Additional Detail data remains scoped to the selected report and captured
-- revision even though older worker policies permit other baseline value types.
CREATE POLICY parameter_detail_worker_read ON template_values AS RESTRICTIVE FOR SELECT TO sampleify_report_worker USING
  (value_type<>'parameter_detail' OR EXISTS (SELECT 1 FROM sample_report_tests chosen JOIN datasheet_submissions submission
    ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id
    WHERE chosen.organization_id=template_values.organization_id AND chosen.report_id=(SELECT report_id FROM laboratory_parameter_context_scope())
      AND submission.instance_id=template_values.instance_id AND template_values.revision<=submission.capture_revision));
REVOKE ALL ON FUNCTION template_check_parameter_detail_request(),template_check_parameter_detail_value(),template_guard_parameter_detail_item()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;

--> statement-breakpoint
CREATE VIEW laboratory_parameter_method_context WITH (security_barrier=true,security_invoker=false) AS
WITH scope AS MATERIALIZED (SELECT * FROM public.laboratory_parameter_read_scope())
SELECT method.organization_id,method.parameter_id,method.revision AS parameter_revision,method.method_id,method.is_default,method.method_revision,method.method_name
FROM scope JOIN public.test_parameter_version_methods method ON method.organization_id=scope.organization_id
WHERE EXISTS (SELECT 1 FROM public.analytical_specifications specification
  WHERE specification.organization_id=method.organization_id AND specification.test_parameter_id=method.parameter_id AND specification.parameter_revision=method.revision
    AND (scope.specification_id IS NULL OR specification.id=scope.specification_id)
    AND (scope.report_id IS NULL OR EXISTS (SELECT 1 FROM public.sample_report_tests chosen
      WHERE chosen.organization_id=scope.organization_id AND chosen.report_id=scope.report_id AND chosen.specification_id=specification.id)));
REVOKE ALL ON laboratory_parameter_method_context FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_parameter_method_context TO sampleify_app,sampleify_report_worker;
