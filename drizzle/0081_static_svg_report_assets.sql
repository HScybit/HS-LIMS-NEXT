ALTER TABLE "report_image_assets" DROP CONSTRAINT "report_image_asset_shape";--> statement-breakpoint
ALTER TABLE "report_image_assets" ADD CONSTRAINT "report_image_asset_shape" CHECK ("report_image_assets"."media_type" in ('image/png','image/jpeg','image/webp','image/svg+xml')
    and length(trim("report_image_assets"."original_name")) between 1 and 255 and "report_image_assets"."sha256" ~ '^[a-f0-9]{64}$'
    and "report_image_assets"."byte_length" between 1 and 10485760 and "report_image_assets"."byte_length"=octet_length("report_image_assets"."content")
    and "report_image_assets"."width" between 1 and 10000 and "report_image_assets"."height" between 1 and 10000 and "report_image_assets"."width"::bigint*"report_image_assets"."height"::bigint<=40000000);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION report_guard_image_asset() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Captured report images are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.sha256 IS DISTINCT FROM encode(sha256(NEW.content),'hex')
    OR NEW.original_name ~ '[[:cntrl:]/\\]'
    OR NOT (CASE NEW.media_type
      WHEN 'image/png' THEN substring(NEW.content from 1 for 8)=decode('89504e470d0a1a0a','hex')
      WHEN 'image/jpeg' THEN substring(NEW.content from 1 for 3)=decode('ffd8ff','hex')
      WHEN 'image/webp' THEN substring(NEW.content from 1 for 4)=convert_to('RIFF','UTF8') AND substring(NEW.content from 9 for 4)=convert_to('WEBP','UTF8')
      -- The application validates XML, CSS and the local reference graph before
      -- decoding, and repeats that validation on every SVG read/render. This
      -- database check verifies encoding/signature without interpreting XML.
      WHEN 'image/svg+xml' THEN convert_from(NEW.content,'UTF8') ~ '<([[:alpha:]_][[:alnum:]_.-]*:)?svg([[:space:]/>])'
        AND position('<!DOCTYPE' in upper(convert_from(NEW.content,'UTF8')))=0
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
