ALTER TABLE "organization_laboratory_settings" ADD COLUMN "allow_receiving_date_edit" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Sample registration needs only this flag, without access to unrelated settings.
CREATE FUNCTION sample_receiving_date_edit_enabled() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.create') OR public.app_has_permission('samples.read')) THEN
    RAISE EXCEPTION 'Sample permission required' USING ERRCODE='42501';
  END IF;
  RETURN coalesce((SELECT settings.allow_receiving_date_edit FROM public.organization_laboratory_settings settings WHERE settings.organization_id=org),false);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sample_receiving_date_edit_enabled() FROM PUBLIC,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION sample_receiving_date_edit_enabled() TO sampleify_app;
