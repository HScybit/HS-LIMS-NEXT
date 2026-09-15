-- Only unused lines may select a different Product/category. Frozen consumers
-- continue to use the immutable line binding established in 0097/0100/0114.
CREATE FUNCTION laboratory_sample_line_in_use(p_org uuid,p_sample uuid,p_line uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sample_tests chosen WHERE chosen.organization_id=p_org AND chosen.sample_product_id=p_line
    AND (chosen.status<>'planned' OR EXISTS (SELECT 1 FROM public.test_requests request WHERE request.organization_id=p_org AND request.sample_test_id=chosen.id)))
    OR EXISTS (SELECT 1 FROM public.test_requests job WHERE job.organization_id=p_org AND job.job_sample_product_id=p_line)
    OR EXISTS (SELECT 1 FROM public.sample_reports report
      LEFT JOIN public.sample_line_contexts context ON context.organization_id=report.organization_id AND context.report_id=report.id
      WHERE report.organization_id=p_org AND report.sample_id=p_sample AND (report.sample_product_id=p_line OR report.product_context_line_id=p_line
        OR context.sample_product_id=p_line OR EXISTS (SELECT 1 FROM public.sample_report_tests member
          WHERE member.organization_id=p_org AND member.report_id=report.id AND member.sample_product_id=p_line)))
$$;
REVOKE ALL ON FUNCTION laboratory_sample_line_in_use(uuid,uuid,uuid) FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_guard_sample_product_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE product public.products; selected_revision integer; sample public.samples;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.sample_id IS DISTINCT FROM OLD.sample_id OR (NEW.product_id=OLD.product_id AND
      (NEW.product_revision,NEW.product_code,NEW.product_name) IS DISTINCT FROM (OLD.product_revision,OLD.product_code,OLD.product_name)) THEN
      RAISE EXCEPTION 'A saved sample line retains its Product identity and captured history' USING ERRCODE='55000';
    END IF;
    IF (NEW.product_id,NEW.sample_category_id) IS DISTINCT FROM (OLD.product_id,OLD.sample_category_id) THEN
      SELECT * INTO sample FROM public.samples WHERE organization_id=OLD.organization_id AND id=OLD.sample_id FOR UPDATE;
      IF public.laboratory_sample_line_in_use(OLD.organization_id,OLD.sample_id,OLD.id) THEN
        RAISE EXCEPTION 'A used sample line retains its Product and category' USING ERRCODE='55000';
      END IF;
      IF session_user='sampleify_app' AND (NOT public.app_has_permission('samples.manage')
        OR sample.sample_type IN ('quality_control','amendment','complaint')) THEN
        RAISE EXCEPTION 'This sample does not allow Product or category changes' USING ERRCODE='42501';
      END IF;
    END IF;
    IF NEW.product_id=OLD.product_id THEN RETURN NEW; END IF;
  ELSIF session_user<>'sampleify_app' THEN
    -- Owner fixtures/imports retain explicitly supplied provenance. No history
    -- or actor is inferred for an older line.
    RETURN NEW;
  END IF;
  IF session_user='sampleify_app' AND (NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR nullif(current_setting('app.user_id',true),'')::uuid IS NULL
    OR NOT (public.app_has_permission('samples.manage') OR (TG_OP='INSERT' AND public.app_has_permission('samples.create')))) THEN
    RAISE EXCEPTION 'Sample registration or management permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO product FROM public.products WHERE organization_id=NEW.organization_id AND id=NEW.product_id FOR SHARE;
  IF NOT FOUND AND TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'The selected Product is unavailable' USING ERRCODE='55000';
  END IF;
  IF NOT FOUND OR NOT product.active OR (NEW.product_code,NEW.product_name) IS DISTINCT FROM (product.code,product.name) THEN
    RAISE EXCEPTION 'Capture the selected active Product name and key' USING ERRCODE='23514',CONSTRAINT='sample_product_current_history';
  END IF;
  SELECT revision INTO selected_revision FROM public.product_versions
    WHERE organization_id=product.organization_id AND product_id=product.id AND revision=product.revision;
  IF NEW.product_revision IS NOT NULL AND NEW.product_revision IS DISTINCT FROM selected_revision THEN
    RAISE EXCEPTION 'Capture the selected current Product revision' USING ERRCODE='23514',CONSTRAINT='sample_product_current_history';
  END IF;
  NEW.product_revision := selected_revision;
  RETURN NEW;
END $$;
--> statement-breakpoint
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
      AND (rule.sample_category_id IS NULL OR rule.sample_category_id=product.sample_category_id)) THEN
    RAISE EXCEPTION 'Decision rule does not match the selected test and product' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION laboratory_guard_sample_test() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
-- A Product change and its replacement planned tests share a transaction.
-- Validate the final association, including direct SQL that omits test updates.
CREATE FUNCTION laboratory_guard_sample_product_tests() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE product public.sample_products;
BEGIN
  IF (NEW.product_id,NEW.sample_category_id) IS NOT DISTINCT FROM (OLD.product_id,OLD.sample_category_id) THEN RETURN NULL; END IF;
  SELECT * INTO product FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.sample_tests chosen JOIN public.decision_rules rule ON rule.organization_id=chosen.organization_id AND rule.id=chosen.decision_rule_id
    WHERE chosen.organization_id=product.organization_id AND chosen.sample_product_id=product.id AND (rule.product_id<>product.product_id
      OR rule.test_parameter_id<>chosen.test_parameter_id OR (rule.method_id IS NOT NULL AND rule.method_id<>chosen.method_id)
      OR (rule.sample_category_id IS NOT NULL AND rule.sample_category_id<>product.sample_category_id))) THEN
    RAISE EXCEPTION 'Decision rule does not match the selected test and product' USING ERRCODE='23514',CONSTRAINT='sample_product_test_context';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laboratory_sample_product_tests AFTER UPDATE ON sample_products DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_product_tests();
REVOKE ALL ON FUNCTION laboratory_guard_sample_product_tests() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION laboratory_guard_sample_line_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE product public.sample_products; sample public.samples;
BEGIN
  IF session_user='sampleify_app' AND (OLD.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NOT public.app_has_permission('samples.manage')) THEN
    RAISE EXCEPTION 'Sample management permission required' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='sample_products' THEN product := OLD;
  ELSE SELECT * INTO product FROM public.sample_products WHERE organization_id=OLD.organization_id AND id=OLD.sample_product_id; END IF;
  SELECT * INTO sample FROM public.samples WHERE organization_id=product.organization_id AND id=product.sample_id FOR UPDATE;
  IF session_user='sampleify_app' AND (sample.sample_type IN ('quality_control','amendment')
    OR (TG_TABLE_NAME='sample_products' AND sample.sample_type='complaint')) THEN
    RAISE EXCEPTION 'This sample does not allow line removal' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='sample_products' THEN
    IF public.laboratory_sample_line_in_use(OLD.organization_id,OLD.sample_id,OLD.id) THEN
      RAISE EXCEPTION 'A used sample line cannot be removed' USING ERRCODE='55000';
    END IF;
  ELSIF OLD.status<>'planned' OR EXISTS (SELECT 1 FROM public.test_requests WHERE organization_id=OLD.organization_id AND sample_test_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=OLD.organization_id AND sample_test_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.sample_report_tests WHERE organization_id=OLD.organization_id AND sample_test_id=OLD.id) THEN
    RAISE EXCEPTION 'A requested test cannot be removed' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER laboratory_sample_product_delete BEFORE DELETE ON sample_products FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_line_delete();
CREATE TRIGGER laboratory_sample_test_delete BEFORE DELETE ON sample_tests FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_line_delete();
REVOKE ALL ON FUNCTION laboratory_guard_sample_line_delete() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT DELETE ON sample_products,sample_tests TO sampleify_app;
