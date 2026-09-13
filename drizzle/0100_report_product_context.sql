ALTER TABLE "sample_reports" ADD COLUMN "product_context_line_id" uuid;--> statement-breakpoint
ALTER TABLE "sample_reports" ADD CONSTRAINT "report_product_context_line_fk" FOREIGN KEY ("organization_id","product_context_line_id") REFERENCES "public"."sample_products"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Record the actual fallback at generation, never reselect it from a later
-- ordering of the sample. Existing report revisions are not backfilled.
CREATE FUNCTION report_guard_product_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_line uuid;
BEGIN
  IF session_user='sampleify_app' THEN
    IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NOT public.app_has_permission('samples.manage') OR NOT public.report_can_print(NEW.sample_id) THEN
      RAISE EXCEPTION 'Report generation permission required' USING ERRCODE='42501';
    END IF;
    PERFORM 1 FROM public.samples WHERE organization_id=NEW.organization_id AND id=NEW.sample_id FOR NO KEY UPDATE;
    SELECT line.id INTO selected_line FROM public.sample_products line WHERE line.organization_id=NEW.organization_id AND line.sample_id=NEW.sample_id
      AND (NEW.sample_product_id IS NULL OR line.id=NEW.sample_product_id) ORDER BY line.display_order,line.id LIMIT 1 FOR SHARE;
    IF selected_line IS NULL OR (NEW.product_context_line_id IS NOT NULL AND NEW.product_context_line_id IS DISTINCT FROM selected_line) THEN
      RAISE EXCEPTION 'Capture the selected report Product line' USING ERRCODE='23514',CONSTRAINT='report_product_context';
    END IF;
    NEW.product_context_line_id:=selected_line;
  END IF;
  -- An importer may supply only recorded history, and any supplied reference
  -- must belong to this sample even when it uses the same organization.
  IF NEW.product_context_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.product_context_line_id AND sample_id=NEW.sample_id
  ) THEN RAISE EXCEPTION 'Report Product context belongs to another sample' USING ERRCODE='23514',CONSTRAINT='report_product_context'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_product_context_guard BEFORE INSERT ON sample_reports FOR EACH ROW EXECUTE FUNCTION report_guard_product_context();
REVOKE ALL ON FUNCTION report_guard_product_context() FROM PUBLIC,sampleify_app,sampleify_report_worker;
