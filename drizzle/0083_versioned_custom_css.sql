CREATE TABLE "organization_custom_css_versions" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"css_content" text NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transaction_id" "xid8" NOT NULL,
	CONSTRAINT "organization_custom_css_version_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "organization_custom_css_revision_key" UNIQUE("organization_id","revision"),
	CONSTRAINT "organization_custom_css_shape" CHECK ("organization_custom_css_versions"."revision">0 and length("organization_custom_css_versions"."css_content")<=1000000)
);
--> statement-breakpoint
ALTER TABLE "organization_custom_css_versions" ADD CONSTRAINT "organization_custom_css_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_custom_css_versions" ADD CONSTRAINT "organization_custom_css_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE organization_custom_css_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_custom_css_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_custom_css_read ON organization_custom_css_versions FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (public.app_has_permission('report_settings.read') OR public.app_has_permission('report_settings.manage')));
GRANT SELECT ON organization_custom_css_versions TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION report_guard_custom_css_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Custom CSS history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER organization_custom_css_immutable BEFORE UPDATE OR DELETE ON organization_custom_css_versions FOR EACH ROW EXECUTE FUNCTION report_guard_custom_css_history();
--> statement-breakpoint
CREATE FUNCTION report_save_custom_css(p_version_id uuid,p_expected_revision integer,p_css text) RETURNS TABLE(version_id uuid,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  previous public.organization_custom_css_versions; existing public.organization_custom_css_versions;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT public.app_has_permission('report_settings.manage') THEN
    RAISE EXCEPTION 'Report settings management permission required' USING ERRCODE='42501';
  END IF;
  p_css:=replace(p_css,E'\r\n',E'\n');
  IF p_version_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>2147483646
    OR p_css IS NULL OR length(p_css)>1000000 OR p_css ~* '<[/]?[[:space:]]*(script|style)\y' THEN
    RAISE EXCEPTION 'Invalid Custom CSS' USING ERRCODE='23514',CONSTRAINT='custom_css_input';
  END IF;
  -- Share report branding's transaction lock so report groups can capture one
  -- consistent set of header/footer/stylesheet revisions.
  PERFORM pg_advisory_xact_lock(hashtextextended('report-documents:'||org::text,0));
  SELECT * INTO existing FROM public.organization_custom_css_versions version WHERE version.organization_id=org AND version.id=p_version_id;
  IF existing.id IS NOT NULL THEN
    IF (existing.revision,existing.css_content,existing.saved_by) IS DISTINCT FROM (p_expected_revision+1,p_css,actor) THEN
      RAISE EXCEPTION 'Custom CSS request was reused' USING ERRCODE='23514',CONSTRAINT='custom_css_request_reused';
    END IF;
    RETURN QUERY SELECT p_version_id,true; RETURN;
  END IF;
  SELECT * INTO previous FROM public.organization_custom_css_versions version WHERE version.organization_id=org ORDER BY version.revision DESC LIMIT 1;
  IF coalesce(previous.revision,0)<>p_expected_revision THEN RAISE EXCEPTION 'Custom CSS changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.organization_custom_css_versions(organization_id,id,revision,css_content,saved_by,transaction_id)
    VALUES(org,p_version_id,p_expected_revision+1,p_css,actor,pg_current_xact_id());
  RETURN QUERY SELECT p_version_id,false;
END $$;
REVOKE ALL ON FUNCTION report_guard_custom_css_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION report_save_custom_css(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_save_custom_css(uuid,integer,text) TO sampleify_app;
