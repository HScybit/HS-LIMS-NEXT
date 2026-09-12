CREATE FUNCTION laboratory_guard_alternate_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.analytical_specifications WHERE organization_id=NEW.organization_id AND id=NEW.specification_id AND basis_specification_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.template_instances capture
      JOIN public.template_versions version ON version.organization_id=capture.organization_id AND version.id=capture.version_id
      JOIN public.test_requests request ON request.organization_id=capture.organization_id AND request.id=NEW.test_request_id
      WHERE capture.organization_id=NEW.organization_id AND capture.id=NEW.template_instance_id
        AND capture.status='editing' AND capture.revision=1 AND capture.created_by=NEW.created_by AND capture.created_at=NEW.created_at
        AND version.template_id=request.datasheet_template_id AND version.kind='datasheet' AND version.status='frozen')
  THEN RAISE EXCEPTION 'An alternate method requires a new capture of its assigned template' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_alternate_capture_guard BEFORE INSERT ON datasheets FOR EACH ROW EXECUTE FUNCTION laboratory_guard_alternate_capture();
