CREATE TABLE "custom_field_attachments" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"field_revision" integer NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_attachment_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "custom_field_attachment_name" CHECK (length(trim("custom_field_attachments"."original_name")) between 1 and 500
    and "custom_field_attachments"."original_name" !~ '[[:cntrl:]]' and position('/' in "custom_field_attachments"."original_name")=0 and position(chr(92) in "custom_field_attachments"."original_name")=0),
	CONSTRAINT "custom_field_attachment_type" CHECK (length("custom_field_attachments"."media_type")<=255 and "custom_field_attachments"."media_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
	CONSTRAINT "custom_field_attachment_content" CHECK ("custom_field_attachments"."byte_length" between 0 and 20971520 and "custom_field_attachments"."byte_length"=octet_length("custom_field_attachments"."content")
    and "custom_field_attachments"."sha256"=encode(sha256("custom_field_attachments"."content"),'hex'))
);
--> statement-breakpoint
ALTER TABLE "custom_field_attachments" ADD CONSTRAINT "custom_field_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_attachments" ADD CONSTRAINT "custom_field_attachment_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_attachments" ADD CONSTRAINT "custom_field_attachment_actor_fk" FOREIGN KEY ("organization_id","uploaded_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_attachment_definition" ON "custom_field_attachments" USING btree ("organization_id","field_id","field_revision");
--> statement-breakpoint
ALTER TABLE custom_field_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_field_attachment_read ON custom_field_attachments FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage'))
  AND EXISTS (SELECT 1 FROM custom_field_versions definition
    WHERE definition.organization_id=custom_field_attachments.organization_id AND definition.field_id=custom_field_attachments.field_id
      AND definition.revision=custom_field_attachments.field_revision AND definition.associated_with='product' AND definition.field_type='attachment')
);
CREATE POLICY custom_field_attachment_insert ON custom_field_attachments FOR INSERT TO sampleify_app WITH CHECK (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage'))
);
GRANT SELECT,INSERT ON custom_field_attachments TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION custom_field_guard_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE definition public.custom_field_definitions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Custom Field attachment bytes are immutable' USING ERRCODE='55000'; END IF;
  IF session_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id FOR SHARE;
  IF definition.id IS NULL OR NOT definition.active OR definition.field_type<>'attachment' OR definition.associated_with<>'product'
    OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires the current active Product field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION custom_field_guard_attachment() FROM PUBLIC;
CREATE TRIGGER custom_field_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON custom_field_attachments
  FOR EACH ROW EXECUTE FUNCTION custom_field_guard_attachment();
