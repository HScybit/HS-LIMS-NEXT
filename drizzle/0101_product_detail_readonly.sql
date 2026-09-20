-- Product details are derived from the captured domain revision. Their source
-- Default Value setting is retained as configuration, never entered history.
CREATE FUNCTION template_guard_product_detail_value() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_fields field WHERE field.organization_id=NEW.organization_id
    AND field.version_id=NEW.version_id AND field.id=NEW.field_id AND field.widget='product_detail_widget') THEN
    RAISE EXCEPTION 'Product details cannot accept captured values' USING ERRCODE='23514',CONSTRAINT='product_detail_readonly';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_product_detail_value_guard BEFORE INSERT ON template_values FOR EACH ROW EXECUTE FUNCTION template_guard_product_detail_value();
REVOKE ALL ON FUNCTION template_guard_product_detail_value() FROM PUBLIC,sampleify_app,sampleify_report_worker;
