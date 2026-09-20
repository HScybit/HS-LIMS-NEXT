-- Migration 0201 (this session, decision rule schema redesign) dropped decision_rules.sample_category_id
-- in favor of the decision_rule_sample_categories join table, but missed two trigger functions from
-- migration 0157 that still referenced the dropped column directly, breaking every sample_tests
-- insert/update that references a decision rule with `rule.sample_category_id does not exist`.
-- Both are rewritten here to check the join table instead: no rows = no category restriction
-- (same meaning NULL had before), otherwise the product's category must be one of the rule's rows.
CREATE OR REPLACE FUNCTION laboratory_guard_sample_test() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE product public.sample_products; sample public.samples; details_changed boolean;
BEGIN
  SELECT * INTO product FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.sample_product_id;
  IF TG_OP='UPDATE' THEN
    IF NEW.sample_product_id IS DISTINCT FROM OLD.sample_product_id THEN
      RAISE EXCEPTION 'A selected test cannot move to another sample product' USING ERRCODE='23514';
    END IF;
    details_changed := (NEW.test_parameter_id,NEW.method_id,NEW.decision_rule_id,NEW.requested_quantity,NEW.requested_size,NEW.rate,NEW.currency_code,
      NEW.estimated_duration_minutes,NEW.is_accredited,NEW.is_retest,NEW.is_subcontracted,NEW.display_order)
      IS DISTINCT FROM (OLD.test_parameter_id,OLD.method_id,OLD.decision_rule_id,OLD.requested_quantity,OLD.requested_size,OLD.rate,OLD.currency_code,
      OLD.estimated_duration_minutes,OLD.is_accredited,OLD.is_retest,OLD.is_subcontracted,OLD.display_order);
    IF details_changed THEN
      SELECT * INTO sample FROM public.samples WHERE organization_id=product.organization_id AND id=product.sample_id FOR UPDATE;
      IF session_user='sampleify_app' AND (NOT public.app_has_permission('samples.manage') OR sample.sample_type IN ('quality_control','amendment')) THEN
        RAISE EXCEPTION 'Sample management permission and an editable sample are required' USING ERRCODE='42501';
      END IF;
      IF (NEW.test_parameter_id,NEW.method_id,NEW.is_retest) IS DISTINCT FROM (OLD.test_parameter_id,OLD.method_id,OLD.is_retest)
        AND (OLD.status<>'planned' OR EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id=OLD.organization_id AND sample_test_id=OLD.id)) THEN
        RAISE EXCEPTION 'Requested test identity cannot be edited' USING ERRCODE='55000';
      END IF;
    END IF;
  ELSIF session_user='sampleify_app' AND NOT (public.app_has_permission('samples.manage')
    OR coalesce(NEW.status='planned' AND product.sample_id=public.laboratory_registering_sample(),false)) THEN
    RAISE EXCEPTION 'Sample creation or management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.decision_rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.decision_rules rule
    WHERE rule.organization_id=NEW.organization_id AND rule.id=NEW.decision_rule_id AND rule.product_id=product.product_id
      AND rule.test_parameter_id=NEW.test_parameter_id AND (rule.method_id IS NULL OR rule.method_id=NEW.method_id)
      AND (
        NOT EXISTS (SELECT 1 FROM public.decision_rule_sample_categories category WHERE category.organization_id=rule.organization_id AND category.decision_rule_id=rule.id)
        OR EXISTS (SELECT 1 FROM public.decision_rule_sample_categories category WHERE category.organization_id=rule.organization_id AND category.decision_rule_id=rule.id AND category.sample_category_id=product.sample_category_id)
      )) THEN
    RAISE EXCEPTION 'Decision rule does not match the selected test and product' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION laboratory_guard_sample_test() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_guard_sample_product_tests() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE product public.sample_products;
BEGIN
  IF (NEW.product_id,NEW.sample_category_id) IS NOT DISTINCT FROM (OLD.product_id,OLD.sample_category_id) THEN RETURN NULL; END IF;
  SELECT * INTO product FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.sample_tests chosen JOIN public.decision_rules rule ON rule.organization_id=chosen.organization_id AND rule.id=chosen.decision_rule_id
    WHERE chosen.organization_id=product.organization_id AND chosen.sample_product_id=product.id AND (rule.product_id<>product.product_id
      OR rule.test_parameter_id<>chosen.test_parameter_id OR (rule.method_id IS NOT NULL AND rule.method_id<>chosen.method_id)
      OR (
        EXISTS (SELECT 1 FROM public.decision_rule_sample_categories category WHERE category.organization_id=rule.organization_id AND category.decision_rule_id=rule.id)
        AND NOT EXISTS (SELECT 1 FROM public.decision_rule_sample_categories category WHERE category.organization_id=rule.organization_id AND category.decision_rule_id=rule.id AND category.sample_category_id=product.sample_category_id)
      ))) THEN
    RAISE EXCEPTION 'Decision rule does not match the selected test and product' USING ERRCODE='23514',CONSTRAINT='sample_product_test_context';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION laboratory_guard_sample_product_tests() FROM PUBLIC,sampleify_app,sampleify_report_worker;
