CREATE TABLE "report_image_assets" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_image_asset_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "report_image_asset_shape" CHECK ("report_image_assets"."media_type" in ('image/png','image/jpeg','image/webp')
    and length(trim("report_image_assets"."original_name")) between 1 and 255 and "report_image_assets"."sha256" ~ '^[a-f0-9]{64}$'
    and "report_image_assets"."byte_length" between 1 and 10485760 and "report_image_assets"."byte_length"=octet_length("report_image_assets"."content")
    and "report_image_assets"."width" between 1 and 10000 and "report_image_assets"."height" between 1 and 10000 and "report_image_assets"."width"::bigint*"report_image_assets"."height"::bigint<=40000000)
);
--> statement-breakpoint
ALTER TABLE "report_image_assets" ADD CONSTRAINT "report_image_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_image_assets" ADD CONSTRAINT "report_image_asset_actor_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO permissions(code,description) VALUES
  ('report_settings.read','View report headers, footers and assets'),
  ('report_settings.manage','Manage report headers, footers and assets') ON CONFLICT DO NOTHING;
ALTER TABLE report_image_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_image_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY report_image_read ON report_image_assets FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (public.app_has_permission('report_settings.read') OR public.app_has_permission('report_settings.manage'))
);
CREATE POLICY report_image_insert ON report_image_assets FOR INSERT TO sampleify_app WITH CHECK (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND public.app_has_permission('report_settings.manage')
);
GRANT SELECT,INSERT ON report_image_assets TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION report_guard_image_asset() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Captured report images are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.sha256 IS DISTINCT FROM encode(sha256(NEW.content),'hex')
    OR NEW.original_name ~ '[[:cntrl:]/\\]'
    OR NOT (CASE NEW.media_type
      WHEN 'image/png' THEN substring(NEW.content from 1 for 8)=decode('89504e470d0a1a0a','hex')
      WHEN 'image/jpeg' THEN substring(NEW.content from 1 for 3)=decode('ffd8ff','hex')
      WHEN 'image/webp' THEN substring(NEW.content from 1 for 4)=convert_to('RIFF','UTF8') AND substring(NEW.content from 9 for 4)=convert_to('WEBP','UTF8')
      ELSE false END) THEN
    RAISE EXCEPTION 'Report image metadata does not match its content' USING ERRCODE='23514',CONSTRAINT='report_image_content';
  END IF;
  IF session_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM now() OR NOT public.app_has_permission('report_settings.manage')) THEN
    RAISE EXCEPTION 'Report image upload is not allowed' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_image_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON report_image_assets
  FOR EACH ROW EXECUTE FUNCTION report_guard_image_asset();
