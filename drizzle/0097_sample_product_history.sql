ALTER TABLE "sample_products" ADD COLUMN "product_revision" integer;--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_product_history_fk" FOREIGN KEY ("organization_id","product_id","product_revision") REFERENCES "public"."product_versions"("organization_id","product_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Older lines retain only the name/code they actually captured. Never infer an
-- earlier Product version from today's head or manufacture missing history.
CREATE FUNCTION laboratory_guard_sample_product_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE product public.products; selected_revision integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.sample_id,NEW.product_id,NEW.product_revision,NEW.product_code,NEW.product_name)
      IS DISTINCT FROM (OLD.sample_id,OLD.product_id,OLD.product_revision,OLD.product_code,OLD.product_name) THEN
      RAISE EXCEPTION 'A saved sample line retains its Product identity and captured history' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Synthetic owner fixtures and a future controlled importer have no inferred
  -- application capture event. A supplied version still has the composite FK.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR nullif(current_setting('app.user_id',true),'')::uuid IS NULL
    OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('samples.create')) THEN
    RAISE EXCEPTION 'Sample registration permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO product FROM public.products WHERE organization_id=NEW.organization_id AND id=NEW.product_id FOR SHARE;
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
CREATE TRIGGER laboratory_sample_product_history BEFORE INSERT OR UPDATE ON sample_products
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_sample_product_history();
REVOKE ALL ON FUNCTION laboratory_guard_sample_product_history() FROM PUBLIC,sampleify_app,sampleify_report_worker;
