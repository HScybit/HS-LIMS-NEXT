-- Match document saves so every group in a report generation uses a consistent
-- set of content versions, including when another session edits or retires one.
CREATE OR REPLACE FUNCTION report_snapshot_assets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE definition public.template_versions; chosen record; version public.report_document_versions;
  header_id uuid; footer_id uuid; nabl_header_id uuid; nabl_footer_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('report-documents:'||NEW.organization_id::text,0));
  SELECT * INTO definition FROM public.template_versions WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id;
  FOR chosen IN SELECT * FROM (VALUES ('header',definition.header_document_id),('footer',definition.footer_document_id),
    ('nablHeader',definition.nabl_header_document_id),('nablFooter',definition.nabl_footer_document_id)) selected(slot,id) WHERE id IS NOT NULL LOOP
    SELECT * INTO version FROM public.report_document_versions item WHERE item.organization_id=NEW.organization_id AND item.document_id=chosen.id ORDER BY item.revision DESC LIMIT 1;
    IF NOT FOUND OR version.is_retired THEN
      RAISE EXCEPTION 'A selected report asset is unavailable' USING ERRCODE='23514',CONSTRAINT='report_asset_unavailable';
    END IF;
    CASE chosen.slot WHEN 'header' THEN header_id:=version.id; WHEN 'footer' THEN footer_id:=version.id;
      WHEN 'nablHeader' THEN nabl_header_id:=version.id; WHEN 'nablFooter' THEN nabl_footer_id:=version.id; END CASE;
  END LOOP;
  INSERT INTO public.sample_report_assets(organization_id,report_id,header_version_id,footer_version_id,nabl_header_version_id,nabl_footer_version_id)
    VALUES(NEW.organization_id,NEW.id,header_id,footer_id,nabl_header_id,nabl_footer_id);
  RETURN NULL;
END $$;
