CREATE TABLE "template_image_assets" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"frame_count" integer NOT NULL,
	"print_content" "bytea" NOT NULL,
	"print_byte_length" integer NOT NULL,
	"print_sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_image_asset_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "template_image_asset_shape" CHECK ("template_image_assets"."media_type" in ('image/png','image/jpeg','image/gif','image/webp') and length(trim("template_image_assets"."original_name")) between 1 and 255
    and "template_image_assets"."sha256" ~ '^[a-f0-9]{64}$' and "template_image_assets"."print_sha256" ~ '^[a-f0-9]{64}$'
    and "template_image_assets"."byte_length" between 1 and 10485760 and "template_image_assets"."byte_length"=octet_length("template_image_assets"."content")
    and "template_image_assets"."print_byte_length" between 1 and 10485760 and "template_image_assets"."print_byte_length"=octet_length("template_image_assets"."print_content")
    and "template_image_assets"."width" between 1 and 10000 and "template_image_assets"."height" between 1 and 10000 and "template_image_assets"."frame_count" between 1 and 200
    and "template_image_assets"."width"::bigint*"template_image_assets"."height"::bigint*"template_image_assets"."frame_count"::bigint<=40000000)
);
--> statement-breakpoint
CREATE TABLE "template_image_config" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value_type" text DEFAULT 'image' NOT NULL,
	"width_percent" double precision DEFAULT 100 NOT NULL,
	"margin_top" double precision DEFAULT 0 NOT NULL,
	"margin_bottom" double precision DEFAULT 0 NOT NULL,
	"margin_left" double precision DEFAULT 0 NOT NULL,
	"margin_right" double precision DEFAULT 0 NOT NULL,
	"alignment" text DEFAULT 'start' NOT NULL,
	CONSTRAINT "template_image_config_pk" PRIMARY KEY("organization_id","version_id","field_id"),
	CONSTRAINT "template_image_config_type" CHECK ("template_image_config"."value_type"='image' and "template_image_config"."alignment" in ('start','center','end')),
	CONSTRAINT "template_image_width_percent_finite" CHECK ("template_image_config"."width_percent" not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)),
	CONSTRAINT "template_image_margin_top_finite" CHECK ("template_image_config"."margin_top" not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)),
	CONSTRAINT "template_image_margin_bottom_finite" CHECK ("template_image_config"."margin_bottom" not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)),
	CONSTRAINT "template_image_margin_left_finite" CHECK ("template_image_config"."margin_left" not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)),
	CONSTRAINT "template_image_margin_right_finite" CHECK ("template_image_config"."margin_right" not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8))
);
--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_widget_type";--> statement-breakpoint
ALTER TABLE "template_fields" DROP CONSTRAINT "template_field_default";--> statement-breakpoint
ALTER TABLE "template_values" DROP CONSTRAINT "template_value_payload";--> statement-breakpoint
ALTER TABLE "template_fields" ADD COLUMN "default_image_id" uuid;--> statement-breakpoint
ALTER TABLE "template_values" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "template_image_assets" ADD CONSTRAINT "template_image_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_image_assets" ADD CONSTRAINT "template_image_asset_actor_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_image_config" ADD CONSTRAINT "template_image_config_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_image_config" ADD CONSTRAINT "template_image_config_field_fk" FOREIGN KEY ("organization_id","version_id","field_id","value_type") REFERENCES "public"."template_fields"("organization_id","version_id","id","value_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_field_default_image_fk" FOREIGN KEY ("organization_id","default_image_id") REFERENCES "public"."template_image_assets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_image_fk" FOREIGN KEY ("organization_id","image_id") REFERENCES "public"."template_image_assets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_image_readonly" CHECK ("template_fields"."widget"<>'template_image_widget' or not "template_fields"."editable");--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'result_widget' and "template_fields"."value_type" in ('numeric', 'result')) or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option') or ("template_fields"."widget" = 'template_image_widget' and "template_fields"."value_type" = 'image'));--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_field_default" CHECK (("template_fields"."default_state" in ('absent', 'empty') and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date", "template_fields"."default_image_id") = 0) or ("template_fields"."default_state" = 'present' and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date", "template_fields"."default_image_id") = 1 and (("template_fields"."value_type" in ('text', 'result') and "template_fields"."default_text" is not null) or ("template_fields"."value_type" in ('numeric', 'result') and "template_fields"."default_number" is not null and "template_fields"."default_number"::text not in ('NaN', 'Infinity', '-Infinity')) or ("template_fields"."value_type" = 'boolean' and "template_fields"."default_boolean" is not null) or ("template_fields"."value_type" = 'date' and "template_fields"."default_date" is not null) or ("template_fields"."value_type" = 'image' and "template_fields"."default_image_id" is not null))));--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_payload" CHECK ((
    ("template_values"."state" in ('absent', 'empty', 'not_applicable', 'invalid') and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id", "template_values"."image_id") = 0) or
    ("template_values"."state" = 'present' and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id", "template_values"."image_id") = 1 and (
      ("template_values"."value_type" in ('numeric', 'result') and "template_values"."number_value" is not null and "template_values"."number_value"::text not in ('NaN', 'Infinity', '-Infinity')) or
      ("template_values"."value_type" in ('text', 'result') and "template_values"."text_value" is not null) or ("template_values"."value_type" = 'boolean' and "template_values"."boolean_value" is not null) or
      ("template_values"."value_type" = 'date' and "template_values"."date_value" is not null) or ("template_values"."value_type" = 'option' and "template_values"."option_id" is not null) or ("template_values"."value_type" = 'image' and "template_values"."image_id" is not null)
    ))) and (("template_values"."state" = 'invalid' and "template_values"."error_code" is not null and "template_values"."error_message" is not null) or ("template_values"."state" <> 'invalid' and "template_values"."error_code" is null and "template_values"."error_message" is null)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_guard_logical_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'template_expression_nodes' THEN
    IF (NEW.expression_id, NEW.node_index) IS DISTINCT FROM (OLD.expression_id, OLD.node_index) THEN
      RAISE EXCEPTION 'Expression node identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME IN ('template_numeric_config','template_image_config') THEN
    IF NEW.field_id IS DISTINCT FROM OLD.field_id THEN RAISE EXCEPTION 'Configuration field identity is immutable' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Logical identity is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_guard_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE capture public.template_instances; occurrence public.template_occurrences; field public.template_fields;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Saved values are append-only' USING ERRCODE = '55000'; END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id = NEW.organization_id AND id = NEW.instance_id FOR UPDATE;
  IF capture.status IS DISTINCT FROM 'editing' OR capture.version_id <> NEW.version_id OR capture.revision <> NEW.revision THEN
    RAISE EXCEPTION 'Value must use the editable capture version and current revision' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO occurrence FROM public.template_occurrences WHERE organization_id = NEW.organization_id AND instance_id = NEW.instance_id AND version_id = NEW.version_id AND id = NEW.occurrence_id;
  SELECT * INTO field FROM public.template_fields WHERE organization_id = NEW.organization_id AND version_id = NEW.version_id AND id = NEW.field_id;
  IF occurrence.id IS NULL OR field.id IS NULL OR occurrence.removed_revision IS NOT NULL OR field.repeat_group_id IS DISTINCT FROM occurrence.group_id THEN
    RAISE EXCEPTION 'Value field and repeat occurrence do not match' USING ERRCODE = '23514';
  END IF;
  IF (field.widget = 'formula_widget') IS DISTINCT FROM (NEW.origin = 'calculated') THEN
    RAISE EXCEPTION 'Calculated fields cannot accept entered values' USING ERRCODE = '23514';
  END IF;
  IF field.widget='template_image_widget' AND NEW.origin<>'default' THEN
    RAISE EXCEPTION 'Template images are frozen defaults' USING ERRCODE='23514';
  END IF;
  IF NEW.origin='default' AND (field.default_state='absent' OR occurrence.created_revision<>NEW.revision
    OR (NEW.state,NEW.number_value,NEW.text_value,NEW.boolean_value,NEW.date_value,NEW.option_id,NEW.image_id,NEW.lexical,NEW.error_code,NEW.error_message)
      IS DISTINCT FROM (field.default_state,field.default_number,field.default_text,field.default_boolean,field.default_date,NULL::uuid,field.default_image_id,field.default_lexical,NULL::text,NULL::text)) THEN
    RAISE EXCEPTION 'Default history must match its frozen field and new occurrence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

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
    'template_fields', 'template_numeric_config', 'template_image_config', 'template_options', 'template_expressions', 'template_expression_nodes'] LOOP
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

--> statement-breakpoint
-- Template assets use template authorization. Originals and print frames never change.
ALTER TABLE template_image_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_image_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE template_image_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_image_config FORCE ROW LEVEL SECURITY;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['template_image_assets','template_image_config'] LOOP
    EXECUTE format('CREATE POLICY definition_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND
      (SELECT app_has_permission(''templates.read'') OR app_has_permission(''templates.manage'') OR laboratory_can_read()))',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('CREATE POLICY report_worker_read ON %I FOR SELECT TO sampleify_report_worker USING
      (organization_id=(SELECT report_pdf_context_org()))',relation);
  END LOOP;
END $$;
CREATE POLICY definition_write ON template_image_config FOR ALL TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('templates.manage')))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('templates.manage')));
CREATE POLICY auto_job_definition_read ON template_image_config FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND version_id IN
    (SELECT id FROM template_versions WHERE organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND template_id=(SELECT laboratory_auto_job_template())));
CREATE POLICY template_image_insert ON template_image_assets FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('templates.manage')));
GRANT INSERT ON template_image_assets TO sampleify_app;
GRANT INSERT,UPDATE,DELETE ON template_image_config TO sampleify_app;

CREATE FUNCTION template_guard_image_asset() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Template image bytes are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.sha256<>encode(sha256(NEW.content),'hex') OR NEW.print_sha256<>encode(sha256(NEW.print_content),'hex')
    OR NEW.original_name ~ '[[:cntrl:]/\\]' OR NEW.original_name<>trim(NEW.original_name)
    OR substring(NEW.print_content FROM 1 FOR 8)<>decode('89504e470d0a1a0a','hex')
    OR (NEW.media_type='image/png' AND substring(NEW.content FROM 1 FOR 8)<>decode('89504e470d0a1a0a','hex'))
    OR (NEW.media_type='image/jpeg' AND substring(NEW.content FROM 1 FOR 3)<>decode('ffd8ff','hex'))
    OR (NEW.media_type='image/gif' AND substring(NEW.content FROM 1 FOR 6) NOT IN (convert_to('GIF87a','UTF8'),convert_to('GIF89a','UTF8')))
    OR (NEW.media_type='image/webp' AND (substring(NEW.content FROM 1 FOR 4)<>convert_to('RIFF','UTF8') OR substring(NEW.content FROM 9 FOR 4)<>convert_to('WEBP','UTF8'))) THEN
    RAISE EXCEPTION 'Template image content does not match its recorded metadata' USING ERRCODE='23514';
  END IF;
  IF current_user='sampleify_app' AND (NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.uploaded_at IS DISTINCT FROM now()
    OR NOT public.app_has_permission('templates.manage')) THEN
    RAISE EXCEPTION 'Template image upload requires its actual tenant and actor' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION template_guard_image_asset() FROM PUBLIC;
CREATE TRIGGER template_image_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON template_image_assets
  FOR EACH ROW EXECUTE FUNCTION template_guard_image_asset();
CREATE TRIGGER definition_guard BEFORE INSERT OR UPDATE OR DELETE ON template_image_config
  FOR EACH ROW EXECUTE FUNCTION template_guard_definition();
CREATE TRIGGER logical_identity_guard BEFORE UPDATE ON template_image_config
  FOR EACH ROW EXECUTE FUNCTION template_guard_logical_identity();

CREATE FUNCTION template_check_image_config() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid; ver uuid; field uuid;
BEGIN
  IF TG_OP='DELETE' THEN org:=OLD.organization_id; ver:=OLD.version_id; field:=OLD.field_id;
  ELSE org:=NEW.organization_id; ver:=NEW.version_id;
    IF TG_TABLE_NAME='template_fields' THEN field:=NEW.id; ELSE field:=NEW.field_id; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.template_fields f WHERE f.organization_id=org AND f.version_id=ver AND f.id=field AND f.widget='template_image_widget')
    AND NOT EXISTS (SELECT 1 FROM public.template_image_config c WHERE c.organization_id=org AND c.version_id=ver AND c.field_id=field) THEN
    RAISE EXCEPTION 'Template image requires its typed layout configuration' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION template_check_image_config() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER template_image_field_complete AFTER INSERT OR UPDATE ON template_fields
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.widget='template_image_widget') EXECUTE FUNCTION template_check_image_config();
CREATE CONSTRAINT TRIGGER template_image_config_complete AFTER INSERT OR UPDATE OR DELETE ON template_image_config
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION template_check_image_config();
