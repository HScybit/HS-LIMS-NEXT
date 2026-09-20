CREATE TABLE "report_watermark_versions" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"watermark_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"image_id" uuid NOT NULL,
	"opacity" numeric NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"rotation" integer NOT NULL,
	"is_retired" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transaction_id" "xid8" NOT NULL,
	CONSTRAINT "report_watermark_version_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "report_watermark_revision_key" UNIQUE("organization_id","watermark_id","revision"),
	CONSTRAINT "report_watermark_version_shape" CHECK ("report_watermark_versions"."revision">0 and length(trim("report_watermark_versions"."name")) between 1 and 200 and "report_watermark_versions"."opacity" between 0 and 1
    and "report_watermark_versions"."width" between 1 and 10000 and "report_watermark_versions"."height" between 1 and 10000 and "report_watermark_versions"."rotation" in (0,90,180,270,360))
);
--> statement-breakpoint
CREATE TABLE "report_watermarks" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_watermark_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "report_watermark_versions" ADD CONSTRAINT "report_watermark_version_watermark_fk" FOREIGN KEY ("organization_id","watermark_id") REFERENCES "public"."report_watermarks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_watermark_versions" ADD CONSTRAINT "report_watermark_version_image_fk" FOREIGN KEY ("organization_id","image_id") REFERENCES "public"."report_image_assets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_watermark_versions" ADD CONSTRAINT "report_watermark_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_watermarks" ADD CONSTRAINT "report_watermarks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_watermarks" ADD CONSTRAINT "report_watermark_actor_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['report_watermarks','report_watermark_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY report_watermark_read ON %I FOR SELECT TO sampleify_app USING (
      organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
      AND (public.app_has_permission(''report_settings.read'') OR public.app_has_permission(''report_settings.manage'')))',target);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',target);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION report_guard_watermark_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Watermark history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER report_watermark_immutable BEFORE UPDATE OR DELETE ON report_watermarks FOR EACH ROW EXECUTE FUNCTION report_guard_watermark_history();
CREATE TRIGGER report_watermark_version_immutable BEFORE UPDATE OR DELETE ON report_watermark_versions FOR EACH ROW EXECUTE FUNCTION report_guard_watermark_history();
--> statement-breakpoint
CREATE FUNCTION report_save_watermark(p_watermark_id uuid,p_version_id uuid,p_expected_revision integer,p_name text,p_image_id uuid,
  p_opacity numeric,p_width integer,p_height integer,p_rotation integer,p_retired boolean) RETURNS TABLE(version_id uuid,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  previous public.report_watermark_versions; existing public.report_watermark_versions;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT public.app_has_permission('report_settings.manage') THEN
    RAISE EXCEPTION 'Report settings management permission required' USING ERRCODE='42501';
  END IF;
  IF p_watermark_id IS NULL OR p_version_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>2147483646
    OR p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 200 OR p_image_id IS NULL
    OR p_opacity IS NULL OR p_opacity NOT BETWEEN 0 AND 1 OR p_width IS NULL OR p_width NOT BETWEEN 1 AND 10000
    OR p_height IS NULL OR p_height NOT BETWEEN 1 AND 10000 OR p_rotation IS NULL OR p_rotation NOT IN (0,90,180,270,360) OR p_retired IS NULL THEN
    RAISE EXCEPTION 'Invalid watermark' USING ERRCODE='23514',CONSTRAINT='report_watermark_input';
  END IF;
  -- Infrequent settings writes serialize per tenant, including reuse of a save
  -- request across different identities. Report generation does not use this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('report-watermarks:'||org::text,0));
  SELECT * INTO existing FROM public.report_watermark_versions version WHERE version.organization_id=org AND version.id=p_version_id;
  IF existing.id IS NOT NULL THEN
    IF (existing.watermark_id,existing.revision,existing.name,existing.image_id,existing.opacity,existing.width,existing.height,existing.rotation,existing.is_retired,existing.saved_by)
      IS DISTINCT FROM (p_watermark_id,p_expected_revision+1,trim(p_name),p_image_id,p_opacity,p_width,p_height,p_rotation,p_retired,actor) THEN
      RAISE EXCEPTION 'Watermark request was reused' USING ERRCODE='23514',CONSTRAINT='report_watermark_request_reused';
    END IF;
    RETURN QUERY SELECT p_version_id,true; RETURN;
  END IF;
  SELECT * INTO previous FROM public.report_watermark_versions version WHERE version.organization_id=org AND version.watermark_id=p_watermark_id ORDER BY version.revision DESC LIMIT 1;
  IF coalesce(previous.revision,0)<>p_expected_revision THEN RAISE EXCEPTION 'Watermark changed' USING ERRCODE='40001'; END IF;
  IF previous.is_retired OR (p_retired AND previous.id IS NULL) THEN
    RAISE EXCEPTION 'Watermark is unavailable' USING ERRCODE='23514',CONSTRAINT='report_watermark_retired';
  END IF;
  IF p_retired AND (trim(p_name),p_image_id,p_opacity,p_width,p_height,p_rotation)
    IS DISTINCT FROM (previous.name,previous.image_id,previous.opacity,previous.width,previous.height,previous.rotation) THEN
    RAISE EXCEPTION 'Deletion must preserve watermark content' USING ERRCODE='23514',CONSTRAINT='report_watermark_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.report_image_assets image WHERE image.organization_id=org AND image.id=p_image_id) THEN
    RAISE EXCEPTION 'Watermark image is unavailable' USING ERRCODE='23514',CONSTRAINT='report_watermark_image';
  END IF;
  IF previous.id IS NULL THEN INSERT INTO public.report_watermarks(organization_id,id,created_by) VALUES(org,p_watermark_id,actor); END IF;
  INSERT INTO public.report_watermark_versions(organization_id,id,watermark_id,revision,name,image_id,opacity,width,height,rotation,is_retired,saved_by,transaction_id)
    VALUES(org,p_version_id,p_watermark_id,p_expected_revision+1,trim(p_name),p_image_id,p_opacity,p_width,p_height,p_rotation,p_retired,actor,pg_current_xact_id());
  RETURN QUERY SELECT p_version_id,false;
END $$;
REVOKE ALL ON FUNCTION report_guard_watermark_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION report_save_watermark(uuid,uuid,integer,text,uuid,numeric,integer,integer,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_save_watermark(uuid,uuid,integer,text,uuid,numeric,integer,integer,integer,boolean) TO sampleify_app;
