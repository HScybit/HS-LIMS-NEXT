-- Sample Category authoring (step 6). The head table, sample_category_templates
-- and sample_category_workflows already carry RLS/grants from earlier phases;
-- only the missing associations, retry support and history are added here.
CREATE TABLE "sample_category_included_fields" (
	"organization_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	CONSTRAINT "sample_category_included_fields_organization_id_sample_category_id_field_definition_id_pk" PRIMARY KEY("organization_id","sample_category_id","field_definition_id")
);
--> statement-breakpoint
CREATE TABLE "sample_category_users" (
	"organization_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sample_category_users_organization_id_sample_category_id_user_id_pk" PRIMARY KEY("organization_id","sample_category_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sample_category_versions" (
	"organization_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"abbreviation" text NOT NULL,
	"retention_days" integer,
	"estimated_time_in_days" double precision NOT NULL,
	"enable_events" boolean NOT NULL,
	"enable_reissue" boolean NOT NULL,
	"active" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "sample_category_version_pk" PRIMARY KEY("organization_id","sample_category_id","revision"),
	CONSTRAINT "sample_category_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "sample_category_version_revision" CHECK (("sample_category_versions"."operation"='create' and "sample_category_versions"."previous_revision" is null and "sample_category_versions"."revision"=1)
    or ("sample_category_versions"."operation" in ('update','retire') and "sample_category_versions"."previous_revision" is not null and "sample_category_versions"."previous_revision">0 and "sample_category_versions"."revision"="sample_category_versions"."previous_revision"+1)),
	CONSTRAINT "sample_category_version_fields" CHECK (length(trim("sample_category_versions"."code")) between 1 and 64 and length(trim("sample_category_versions"."name")) between 1 and 250
    and ("sample_category_versions"."operation"='retire' or (length(trim("sample_category_versions"."name"))<=200 and length("sample_category_versions"."description")<=16000 and length(trim("sample_category_versions"."abbreviation")) between 1 and 64
      and "sample_category_versions"."retention_days">=0 and "sample_category_versions"."estimated_time_in_days">=0
      and "sample_category_versions"."estimated_time_in_days" not in ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision)))
    and ("sample_category_versions"."operation"<>'retire' or not "sample_category_versions"."active"))
);
--> statement-breakpoint
ALTER TABLE "sample_categories" ADD COLUMN "save_request_id" uuid;--> statement-breakpoint
ALTER TABLE "sample_category_included_fields" ADD CONSTRAINT "sample_category_included_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_included_fields" ADD CONSTRAINT "sample_category_included_field_category_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_included_fields" ADD CONSTRAINT "sample_category_included_field_definition_fk" FOREIGN KEY ("organization_id","field_definition_id") REFERENCES "public"."custom_field_definitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_users" ADD CONSTRAINT "sample_category_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_users" ADD CONSTRAINT "sample_category_user_category_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_users" ADD CONSTRAINT "sample_category_user_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_versions" ADD CONSTRAINT "sample_category_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_versions" ADD CONSTRAINT "sample_category_version_parent_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_category_versions" ADD CONSTRAINT "sample_category_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."sample_category_user_labels" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT member.organization_id,person.id,person.username,person.display_name,(member.active AND person.active) AS active
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
);--> statement-breakpoint
REVOKE ALL ON sample_category_user_labels FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON sample_category_user_labels TO sampleify_app;
--> statement-breakpoint

CREATE FUNCTION masters_guard_sample_category_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Sample Category history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
    OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
    RAISE EXCEPTION 'Sample Category history requires the actual editor and transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE sample_category_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_category_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY sample_category_version_read ON sample_category_versions FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
GRANT SELECT ON sample_category_versions TO sampleify_app;
CREATE TRIGGER sample_category_history_guard BEFORE INSERT OR UPDATE OR DELETE ON sample_category_versions
  FOR EACH ROW EXECUTE FUNCTION masters_guard_sample_category_history();

CREATE FUNCTION masters_track_sample_category() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Existing migration/fixture records gain history only on an actual app edit.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Sample Category writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New Sample Categories start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Sample Category writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND (NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.retention_days,NEW.estimated_time_in_days,NEW.enable_events,NEW.enable_reissue)
      IS DISTINCT FROM (OLD.code,OLD.name,OLD.description,OLD.abbreviation,OLD.retention_days,OLD.estimated_time_in_days,OLD.enable_events,OLD.enable_reissue) THEN
      RAISE EXCEPTION 'Sample Category retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.sample_category_versions(organization_id,sample_category_id,revision,request_id,previous_revision,operation,
    code,name,description,abbreviation,retention_days,estimated_time_in_days,enable_events,enable_reissue,active,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.retention_days,NEW.estimated_time_in_days,NEW.enable_events,NEW.enable_reissue,NEW.active,actor);
  RETURN NEW;
END $$;
CREATE TRIGGER master_sample_category_version AFTER INSERT OR UPDATE ON sample_categories FOR EACH ROW EXECUTE FUNCTION masters_track_sample_category();
REVOKE ALL ON FUNCTION masters_guard_sample_category_history(),masters_track_sample_category() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['sample_category_users','sample_category_included_fields'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY sample_category_child_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('CREATE POLICY sample_category_child_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
--> statement-breakpoint

-- Product's own sample-category selection was read-only pending this master's existence.
GRANT INSERT,DELETE ON product_sample_categories TO sampleify_app;
CREATE OR REPLACE FUNCTION masters_guard_product_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.product_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Product history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='product_versions' THEN
    IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Product history requires the actual editor and transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.product_versions WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.revision;
    IF version.product_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
        OR NOT EXISTS (SELECT 1 FROM public.products WHERE organization_id=NEW.organization_id AND id=NEW.product_id
          AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
      RAISE EXCEPTION 'Product links require their new version transaction' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='product_version_tags' THEN
      IF NEW.position>=version.tag_count THEN RAISE EXCEPTION 'Product tag position exceeds its saved count' USING ERRCODE='23514'; END IF;
      IF version.operation='retire' THEN
        IF NOT EXISTS (SELECT 1 FROM public.product_tags WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND tag_id=NEW.tag_id) THEN
          RAISE EXCEPTION 'Product retirement preserves its tags' USING ERRCODE='23514';
        END IF;
      ELSE
        PERFORM 1 FROM public.tags WHERE organization_id=NEW.organization_id AND id=NEW.tag_id AND active FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Select active tags in this organization' USING ERRCODE='23514',CONSTRAINT='product_active_tag'; END IF;
      END IF;
    ELSIF TG_TABLE_NAME='product_version_sample_categories' THEN
      IF version.operation='retire' THEN
        IF NOT EXISTS (SELECT 1 FROM public.product_sample_categories WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND sample_category_id=NEW.sample_category_id) THEN
          RAISE EXCEPTION 'Product retirement preserves its sample categories' USING ERRCODE='23514';
        END IF;
      ELSE
        PERFORM 1 FROM public.sample_categories WHERE organization_id=NEW.organization_id AND id=NEW.sample_category_id AND active FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Select active Sample Categories in this organization' USING ERRCODE='23514',CONSTRAINT='product_active_sample_category'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

