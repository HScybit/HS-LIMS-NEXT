CREATE TABLE "sample_report_assets" (
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"header_version_id" uuid,
	"footer_version_id" uuid,
	"nabl_header_version_id" uuid,
	"nabl_footer_version_id" uuid,
	CONSTRAINT "report_asset_pk" PRIMARY KEY("organization_id","report_id")
);
--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "header_document_id" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "footer_document_id" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "nabl_header_document_id" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "nabl_footer_document_id" uuid;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "sample_report_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "report_asset_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."sample_reports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "sample_report_assets_organization_id_header_version_id_report_document_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","header_version_id") REFERENCES "public"."report_document_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "sample_report_assets_organization_id_footer_version_id_report_document_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","footer_version_id") REFERENCES "public"."report_document_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "sample_report_assets_organization_id_nabl_header_version_id_report_document_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","nabl_header_version_id") REFERENCES "public"."report_document_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_assets" ADD CONSTRAINT "sample_report_assets_organization_id_nabl_footer_version_id_report_document_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","nabl_footer_version_id") REFERENCES "public"."report_document_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_header_document_id_report_documents_organization_id_id_fk" FOREIGN KEY ("organization_id","header_document_id") REFERENCES "public"."report_documents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_footer_document_id_report_documents_organization_id_id_fk" FOREIGN KEY ("organization_id","footer_document_id") REFERENCES "public"."report_documents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_nabl_header_document_id_report_documents_organization_id_id_fk" FOREIGN KEY ("organization_id","nabl_header_document_id") REFERENCES "public"."report_documents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_nabl_footer_document_id_report_documents_organization_id_id_fk" FOREIGN KEY ("organization_id","nabl_footer_document_id") REFERENCES "public"."report_documents"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION report_guard_template_assets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE chosen record;
BEGIN
  FOR chosen IN SELECT * FROM (VALUES (NEW.header_document_id,'header'),(NEW.footer_document_id,'footer'),
    (NEW.nabl_header_document_id,'header'),(NEW.nabl_footer_document_id,'footer')) selected(id,type) WHERE id IS NOT NULL LOOP
    IF NOT EXISTS (SELECT 1 FROM public.report_documents document WHERE document.organization_id=NEW.organization_id AND document.id=chosen.id AND document.type=chosen.type) THEN
      RAISE EXCEPTION 'Select a report asset of the matching type and organization' USING ERRCODE='23514',CONSTRAINT='template_report_asset_type';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER template_report_assets_guard BEFORE INSERT OR UPDATE OF header_document_id,footer_document_id,nabl_header_document_id,nabl_footer_document_id ON template_versions
  FOR EACH ROW EXECUTE FUNCTION report_guard_template_assets();
--> statement-breakpoint
CREATE FUNCTION report_snapshot_assets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE definition public.template_versions; chosen record; version public.report_document_versions;
  header_id uuid; footer_id uuid; nabl_header_id uuid; nabl_footer_id uuid;
BEGIN
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
-- Existing reports receive no inferred historical asset selection.
CREATE TRIGGER report_capture_assets AFTER INSERT ON sample_reports FOR EACH ROW EXECUTE FUNCTION report_snapshot_assets();
CREATE TRIGGER report_assets_immutable BEFORE UPDATE OR DELETE ON sample_report_assets FOR EACH ROW EXECUTE FUNCTION report_guard_document_history();
--> statement-breakpoint
ALTER TABLE sample_report_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_report_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY report_assets_read ON sample_report_assets FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (
    SELECT 1 FROM public.sample_reports report WHERE report.organization_id=sample_report_assets.organization_id AND report.id=sample_report_assets.report_id
      AND public.report_can_print(report.sample_id)));
GRANT SELECT ON sample_report_assets TO sampleify_app;
CREATE POLICY report_document_version_snapshot_read ON report_document_versions FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM public.sample_report_assets snapshot
    WHERE snapshot.organization_id=report_document_versions.organization_id AND report_document_versions.id IN (snapshot.header_version_id,snapshot.footer_version_id,snapshot.nabl_header_version_id,snapshot.nabl_footer_version_id)));
CREATE POLICY report_document_image_snapshot_read ON report_document_images FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM public.sample_report_assets snapshot
    WHERE snapshot.organization_id=report_document_images.organization_id AND report_document_images.version_id IN (snapshot.header_version_id,snapshot.footer_version_id,snapshot.nabl_header_version_id,snapshot.nabl_footer_version_id)));
CREATE POLICY report_image_snapshot_read ON report_image_assets FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND EXISTS (SELECT 1 FROM public.report_document_images image
    WHERE image.organization_id=report_image_assets.organization_id AND image.image_id=report_image_assets.id));
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['sample_report_assets','report_document_versions','report_document_images','report_image_assets'] LOOP
    EXECUTE format('GRANT SELECT ON %I TO sampleify_report_worker',relation);
    EXECUTE format('CREATE POLICY report_worker_read ON %I FOR SELECT TO sampleify_report_worker USING (organization_id=(SELECT report_pdf_context_org()))',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION report_document_options() RETURNS TABLE(id uuid,type text,name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT (public.app_has_permission('templates.read') OR public.app_has_permission('templates.manage')) THEN
    RAISE EXCEPTION 'Template permission required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT document.id,document.type,version.name FROM public.report_documents document
    JOIN LATERAL (SELECT * FROM public.report_document_versions item WHERE item.organization_id=document.organization_id AND item.document_id=document.id ORDER BY item.revision DESC LIMIT 1) version ON true
    WHERE document.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND NOT version.is_retired ORDER BY version.name,document.id;
END $$;
GRANT EXECUTE ON FUNCTION report_document_options() TO sampleify_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_snapshot_from_draft(source_id uuid, expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  source public.template_versions; snapshot_id uuid; template_id uuid; relation text; column_names text;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT (
    public.app_has_permission('templates.manage') OR public.app_has_permission('test_requests.allocate')
    OR public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
    OR coalesce((SELECT v.template_id FROM public.template_versions v WHERE v.organization_id=org AND v.id=source_id)=public.laboratory_auto_job_template(),false)
  ) THEN RAISE EXCEPTION 'Runtime snapshot permission required' USING ERRCODE = '42501'; END IF;
  SELECT v.template_id INTO template_id FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id;
  PERFORM 1 FROM public.templates t WHERE t.organization_id = org AND t.id = template_id AND t.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template is unavailable' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO source FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id FOR UPDATE;
  IF source.status <> 'draft' OR source.revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'Template revision changed' USING ERRCODE = '40001';
  END IF;
  SELECT v.id INTO snapshot_id FROM public.template_versions v WHERE v.organization_id = org
    AND v.snapshot_source_id = source.id AND v.snapshot_source_revision = source.revision AND v.status = 'frozen';
  IF snapshot_id IS NOT NULL THEN RETURN snapshot_id; END IF;
  INSERT INTO public.template_versions (organization_id, template_id, number, status, name, description, kind,
    template_type, semantics, created_by, snapshot_source_id, snapshot_source_revision, header_document_id, footer_document_id, nabl_header_document_id, nabl_footer_document_id)
    SELECT org, source.template_id, coalesce(max(v.number), 0) + 1, 'building', source.name, source.description, source.kind,
      source.template_type, source.semantics, actor, source.id, source.revision, source.header_document_id, source.footer_document_id, source.nabl_header_document_id, source.nabl_footer_document_id
    FROM public.template_versions v WHERE v.organization_id = org AND v.template_id = source.template_id RETURNING id INTO snapshot_id;
  -- Only these definition tables are copied. Column identifiers come from PostgreSQL's
  -- catalog, never request data; new typed scalar columns are copied with their version.
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_repeat_groups',
    'template_fields', 'template_numeric_config', 'template_options', 'template_expressions', 'template_expression_nodes'] LOOP
    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO column_names FROM pg_attribute
      WHERE attrelid = format('public.%I', relation)::regclass AND attnum > 0 AND NOT attisdropped
        AND attname NOT IN ('organization_id', 'version_id') AND attgenerated = '';
    EXECUTE format('INSERT INTO public.%I (organization_id, version_id, %s)
      SELECT $1, $2, %s FROM public.%I WHERE organization_id = $1 AND version_id = $3', relation, column_names, column_names, relation)
      USING org, snapshot_id, source.id;
  END LOOP;
  UPDATE public.template_versions SET status = 'frozen', revision = revision + 1, frozen_at = now(), frozen_by = actor
    WHERE organization_id = org AND id = snapshot_id;
  RETURN snapshot_id;
END $$;
