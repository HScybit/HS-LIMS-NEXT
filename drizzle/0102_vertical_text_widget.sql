-- Vertical Text reads its configured title, including during capture. The
-- shared Default Value is configuration and never an entered/default result.
CREATE FUNCTION template_guard_vertical_text_value() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_fields field WHERE field.organization_id=NEW.organization_id
    AND field.version_id=NEW.version_id AND field.id=NEW.field_id AND field.widget='vertical_text_widget') THEN
    RAISE EXCEPTION 'Vertical Text cannot accept captured values' USING ERRCODE='23514',CONSTRAINT='vertical_text_readonly';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_vertical_text_value_guard BEFORE INSERT ON template_values FOR EACH ROW EXECUTE FUNCTION template_guard_vertical_text_value();
REVOKE ALL ON FUNCTION template_guard_vertical_text_value() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_widget_type";--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_vertical_text_readonly" CHECK ("template_fields"."widget"<>'vertical_text_widget' or not "template_fields"."editable");--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'vertical_text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'product_detail_widget', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'result_widget' and "template_fields"."value_type" in ('numeric', 'result')) or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option') or ("template_fields"."widget" = 'template_image_widget' and "template_fields"."value_type" = 'image'));
