-- Qualify the outer image identifier so a missing image is rejected before insertion.
CREATE OR REPLACE FUNCTION report_save_document(p_document_id uuid,p_version_id uuid,p_expected_revision integer,p_type text,p_name text,p_html text,
  p_default boolean,p_retired boolean,p_image_ids uuid[]) RETURNS TABLE(version_id uuid,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  document public.report_documents; previous public.report_document_versions; existing public.report_document_versions;
  image_ids uuid[]; captured_ids uuid[];
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT public.app_has_permission('report_settings.manage') THEN
    RAISE EXCEPTION 'Report settings management permission required' USING ERRCODE='42501';
  END IF;
  IF p_document_id IS NULL OR p_version_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>2147483646
    OR p_type IS NULL OR p_type NOT IN ('header','footer') OR p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 200
    OR p_html IS NULL OR length(p_html)>1000000 OR p_default IS NULL OR p_retired IS NULL
    OR (p_default AND (p_type<>'header' OR p_retired)) OR p_image_ids IS NULL OR cardinality(p_image_ids)>100
    OR array_position(p_image_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid report document' USING ERRCODE='23514',CONSTRAINT='report_document_input';
  END IF;
  SELECT coalesce(array_agg(DISTINCT image_id ORDER BY image_id),'{}'::uuid[]) INTO image_ids FROM unnest(p_image_ids) image_id;
  -- Save/default selection is infrequent. One tenant lock makes revision checks,
  -- default switching and response retries atomic without cross-tenant blocking.
  PERFORM pg_advisory_xact_lock(hashtextextended('report-documents:'||org::text,0));
  SELECT * INTO existing FROM public.report_document_versions version WHERE version.organization_id=org AND version.id=p_version_id;
  SELECT * INTO document FROM public.report_documents WHERE organization_id=org AND id=p_document_id;
  IF existing.id IS NOT NULL THEN
    SELECT coalesce(array_agg(image.image_id ORDER BY image.image_id),'{}'::uuid[]) INTO captured_ids
      FROM public.report_document_images image WHERE image.organization_id=org AND image.version_id=p_version_id;
    IF (existing.document_id,existing.revision,existing.name,existing.template_html,existing.requested_default,existing.is_retired,existing.saved_by)
      IS DISTINCT FROM (p_document_id,p_expected_revision+1,trim(p_name),p_html,p_default,p_retired,actor)
      OR document.type IS DISTINCT FROM p_type OR captured_ids IS DISTINCT FROM image_ids THEN
      RAISE EXCEPTION 'Report document request was reused' USING ERRCODE='23514',CONSTRAINT='report_document_request_reused';
    END IF;
    RETURN QUERY SELECT p_version_id,true; RETURN;
  END IF;
  SELECT * INTO previous FROM public.report_document_versions version WHERE version.organization_id=org AND version.document_id=p_document_id ORDER BY version.revision DESC LIMIT 1;
  IF coalesce(previous.revision,0)<>p_expected_revision THEN
    RAISE EXCEPTION 'Report document changed' USING ERRCODE='40001';
  END IF;
  IF previous.is_retired OR (p_retired AND previous.id IS NULL) THEN
    RAISE EXCEPTION 'Report document is unavailable' USING ERRCODE='23514',CONSTRAINT='report_document_retired';
  END IF;
  IF document.id IS NOT NULL AND document.type IS DISTINCT FROM p_type THEN
    RAISE EXCEPTION 'Report document type cannot change' USING ERRCODE='23514',CONSTRAINT='report_document_type';
  END IF;
  IF p_retired AND (p_name,p_html) IS DISTINCT FROM (previous.name,previous.template_html) THEN
    RAISE EXCEPTION 'Deletion must preserve the saved content' USING ERRCODE='23514',CONSTRAINT='report_document_input';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(image_ids) AS selected(image_id) WHERE NOT EXISTS (SELECT 1 FROM public.report_image_assets image WHERE image.organization_id=org AND image.id=selected.image_id))
    OR (SELECT coalesce(sum(byte_length),0) FROM public.report_image_assets WHERE organization_id=org AND id=ANY(image_ids))>26214400 THEN
    RAISE EXCEPTION 'Report images are unavailable or exceed 25 MiB' USING ERRCODE='23514',CONSTRAINT='report_document_images';
  END IF;
  IF document.id IS NULL THEN
    INSERT INTO public.report_documents(organization_id,id,type,created_by) VALUES(org,p_document_id,p_type,actor);
  END IF;
  INSERT INTO public.report_document_versions(organization_id,id,document_id,revision,name,template_html,is_retired,requested_default,saved_by,transaction_id)
    VALUES(org,p_version_id,p_document_id,p_expected_revision+1,trim(p_name),p_html,p_retired,p_default,actor,pg_current_xact_id());
  INSERT INTO public.report_document_images(organization_id,version_id,image_id) SELECT org,p_version_id,id FROM unnest(image_ids) id;
  IF p_type='header' THEN
    IF p_default THEN
      INSERT INTO public.report_document_defaults(organization_id,default_header_id,changed_version_id) VALUES(org,p_document_id,p_version_id)
        ON CONFLICT(organization_id) DO UPDATE SET default_header_id=EXCLUDED.default_header_id,changed_version_id=EXCLUDED.changed_version_id;
    ELSE
      UPDATE public.report_document_defaults SET default_header_id=NULL,changed_version_id=p_version_id WHERE organization_id=org AND default_header_id=p_document_id;
    END IF;
  END IF;
  RETURN QUERY SELECT p_version_id,false;
END $$;
