-- Earlier versions did not record a Lab name. NULL preserves that unknown provenance.
ALTER TABLE test_parameter_versions ADD COLUMN laboratory_name text;
ALTER TABLE test_parameter_versions ADD CONSTRAINT parameter_version_laboratory_label
  CHECK (laboratory_id IS NOT NULL OR laboratory_name IS NULL);
--> statement-breakpoint
CREATE FUNCTION masters_capture_parameter_laboratory_label() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- As with existing parameter/method observations, owner import/fixture provenance is explicit and separate.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NOT public.app_has_permission('masters.manage') THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  NEW.laboratory_name:=NULL;
  IF NEW.laboratory_id IS NOT NULL THEN
    SELECT name INTO NEW.laboratory_name FROM public.laboratories
      WHERE organization_id=NEW.organization_id AND id=NEW.laboratory_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Parameter laboratory was not found' USING ERRCODE='23503'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parameter_laboratory_label_capture BEFORE INSERT ON test_parameter_versions
  FOR EACH ROW EXECUTE FUNCTION masters_capture_parameter_laboratory_label();
REVOKE ALL ON FUNCTION masters_capture_parameter_laboratory_label() FROM PUBLIC,sampleify_app,sampleify_report_worker;
