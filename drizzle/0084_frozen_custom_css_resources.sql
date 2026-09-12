CREATE TABLE "organization_custom_css_images" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	CONSTRAINT "organization_custom_css_image_pk" PRIMARY KEY("organization_id","version_id","image_id")
);
--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD COLUMN "css_version_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_custom_css_images" ADD CONSTRAINT "organization_custom_css_image_version_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."organization_custom_css_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_custom_css_images" ADD CONSTRAINT "organization_custom_css_image_asset_fk" FOREIGN KEY ("organization_id","image_id") REFERENCES "public"."report_image_assets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "report_asset_custom_css_fk" FOREIGN KEY ("organization_id","css_version_id") REFERENCES "public"."organization_custom_css_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE organization_custom_css_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_custom_css_images FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_custom_css_image_read ON organization_custom_css_images FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (public.app_has_permission('report_settings.read') OR public.app_has_permission('report_settings.manage')));
GRANT SELECT ON organization_custom_css_images TO sampleify_app;
CREATE POLICY custom_css_snapshot_read ON organization_custom_css_versions FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM public.sample_report_assets snapshot
    WHERE snapshot.organization_id=organization_custom_css_versions.organization_id AND snapshot.css_version_id=organization_custom_css_versions.id));
CREATE POLICY custom_css_image_snapshot_read ON organization_custom_css_images FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM public.sample_report_assets snapshot
    WHERE snapshot.organization_id=organization_custom_css_images.organization_id AND snapshot.css_version_id=organization_custom_css_images.version_id));
CREATE POLICY report_image_css_snapshot_read ON report_image_assets FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM public.organization_custom_css_images image
    WHERE image.organization_id=report_image_assets.organization_id AND image.image_id=report_image_assets.id));
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['organization_custom_css_versions','organization_custom_css_images'] LOOP
    EXECUTE format('GRANT SELECT ON %I TO sampleify_report_worker',relation);
    EXECUTE format('CREATE POLICY report_worker_read ON %I FOR SELECT TO sampleify_report_worker USING (organization_id=(SELECT report_pdf_context_org()))',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION report_guard_custom_css_images() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Custom CSS image history is immutable' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_custom_css_versions version
    WHERE version.organization_id=NEW.organization_id AND version.id=NEW.version_id
      AND version.transaction_id=pg_current_xact_id() AND version.saved_at=now()) THEN
    RAISE EXCEPTION 'Image references must be captured with their stylesheet version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_custom_css_images_immutable BEFORE INSERT OR UPDATE OR DELETE ON organization_custom_css_images
  FOR EACH ROW EXECUTE FUNCTION report_guard_custom_css_images();
REVOKE ALL ON FUNCTION report_guard_custom_css_images() FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION report_save_custom_css(uuid,integer,text);
CREATE FUNCTION report_save_custom_css(p_version_id uuid,p_expected_revision integer,p_css text,p_image_ids uuid[]) RETURNS TABLE(version_id uuid,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  previous public.organization_custom_css_versions; existing public.organization_custom_css_versions;
  image_ids uuid[]; captured_ids uuid[];
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT public.app_has_permission('report_settings.manage') THEN
    RAISE EXCEPTION 'Report settings management permission required' USING ERRCODE='42501';
  END IF;
  p_css:=replace(p_css,E'\r\n',E'\n');
  IF p_version_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>2147483646
    OR p_css IS NULL OR length(p_css)>1000000 OR p_css ~* '<[/]?[[:space:]]*(script|style)\y'
    OR p_image_ids IS NULL OR cardinality(p_image_ids)>100 OR array_position(p_image_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid Custom CSS' USING ERRCODE='23514',CONSTRAINT='custom_css_input';
  END IF;
  SELECT coalesce(array_agg(DISTINCT image_id ORDER BY image_id),'{}'::uuid[]) INTO image_ids FROM unnest(p_image_ids) image_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('report-documents:'||org::text,0));
  SELECT * INTO existing FROM public.organization_custom_css_versions version WHERE version.organization_id=org AND version.id=p_version_id;
  IF existing.id IS NOT NULL THEN
    SELECT coalesce(array_agg(image.image_id ORDER BY image.image_id),'{}'::uuid[]) INTO captured_ids
      FROM public.organization_custom_css_images image WHERE image.organization_id=org AND image.version_id=p_version_id;
    IF (existing.revision,existing.css_content,existing.saved_by) IS DISTINCT FROM (p_expected_revision+1,p_css,actor) OR captured_ids IS DISTINCT FROM image_ids THEN
      RAISE EXCEPTION 'Custom CSS request was reused' USING ERRCODE='23514',CONSTRAINT='custom_css_request_reused';
    END IF;
    RETURN QUERY SELECT p_version_id,true; RETURN;
  END IF;
  SELECT * INTO previous FROM public.organization_custom_css_versions version WHERE version.organization_id=org ORDER BY version.revision DESC LIMIT 1;
  IF coalesce(previous.revision,0)<>p_expected_revision THEN RAISE EXCEPTION 'Custom CSS changed' USING ERRCODE='40001'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(image_ids) AS selected(image_id) WHERE NOT EXISTS (
    SELECT 1 FROM public.report_image_assets image WHERE image.organization_id=org AND image.id=selected.image_id))
    OR (SELECT coalesce(sum(byte_length),0) FROM public.report_image_assets WHERE organization_id=org AND id=ANY(image_ids))>25165824 THEN
    RAISE EXCEPTION 'Custom CSS images are unavailable or exceed 24 MiB' USING ERRCODE='23514',CONSTRAINT='custom_css_images';
  END IF;
  INSERT INTO public.organization_custom_css_versions(organization_id,id,revision,css_content,saved_by,transaction_id)
    VALUES(org,p_version_id,p_expected_revision+1,p_css,actor,pg_current_xact_id());
  INSERT INTO public.organization_custom_css_images(organization_id,version_id,image_id) SELECT org,p_version_id,id FROM unnest(image_ids) id;
  RETURN QUERY SELECT p_version_id,false;
END $$;
REVOKE ALL ON FUNCTION report_save_custom_css(uuid,integer,text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_save_custom_css(uuid,integer,text,uuid[]) TO sampleify_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION report_snapshot_assets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE definition public.template_versions; chosen record; version public.report_document_versions;
  header_id uuid; footer_id uuid; nabl_header_id uuid; nabl_footer_id uuid; css_id uuid;
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
  SELECT id INTO css_id FROM public.organization_custom_css_versions WHERE organization_id=NEW.organization_id ORDER BY revision DESC LIMIT 1;
  INSERT INTO public.sample_report_assets(organization_id,report_id,header_version_id,footer_version_id,nabl_header_version_id,nabl_footer_version_id,css_version_id)
    VALUES(NEW.organization_id,NEW.id,header_id,footer_id,nabl_header_id,nabl_footer_id,css_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Source application styling is visible to organization members. This command
-- exposes only the latest stylesheet and its image bytes, never settings history.
CREATE FUNCTION report_current_custom_css() RETURNS TABLE(kind text,id uuid,revision integer,css_content text,saved_at timestamptz,
  image_ids uuid[],media_type text,content bytea,image_bytes bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memberships member JOIN public.users person ON person.id=member.user_id AND person.active
    JOIN public.organizations organization ON organization.id=member.organization_id AND organization.active
    WHERE member.organization_id=org AND member.user_id=actor AND member.active) THEN
    RAISE EXCEPTION 'Organization membership required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY WITH latest AS (
    SELECT version.* FROM public.organization_custom_css_versions version WHERE version.organization_id=org ORDER BY version.revision DESC LIMIT 1
  ), images AS (
    SELECT image.* FROM public.report_image_assets image JOIN public.organization_custom_css_images link
      ON link.organization_id=image.organization_id AND link.image_id=image.id
    WHERE link.organization_id=org AND link.version_id=(SELECT version.id FROM latest version)
  ), size AS (SELECT coalesce(sum(image.byte_length),0)::bigint AS bytes FROM images image)
  SELECT 'stylesheet',version.id,version.revision,version.css_content,version.saved_at,
    ARRAY(SELECT link.image_id FROM public.organization_custom_css_images link WHERE link.organization_id=org AND link.version_id=version.id ORDER BY link.image_id),
    NULL::text,NULL::bytea,(SELECT bytes FROM size) FROM latest version
  UNION ALL SELECT 'image',image.id,NULL,NULL,NULL,NULL,image.media_type,CASE WHEN (SELECT bytes FROM size)<=25165824 THEN image.content ELSE NULL END,
    (SELECT bytes FROM size) FROM images image;
END $$;
REVOKE ALL ON FUNCTION report_current_custom_css() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_current_custom_css() TO sampleify_app;
