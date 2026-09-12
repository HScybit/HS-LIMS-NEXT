CREATE TABLE "product_version_sample_categories" (
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"sample_category_id" uuid NOT NULL,
	CONSTRAINT "product_version_category_pk" PRIMARY KEY("organization_id","product_id","revision","sample_category_id")
);
--> statement-breakpoint
CREATE TABLE "product_version_tags" (
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"tag_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "product_version_tag_pk" PRIMARY KEY("organization_id","product_id","revision","tag_id"),
	CONSTRAINT "product_version_tag_position" UNIQUE("organization_id","product_id","revision","position"),
	CONSTRAINT "product_version_tag_order" CHECK ("product_version_tags"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_versions" (
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"abbreviation" text,
	"job_template_id" uuid,
	"active" boolean NOT NULL,
	"tag_count" integer NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "product_version_pk" PRIMARY KEY("organization_id","product_id","revision"),
	CONSTRAINT "product_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "product_version_revision" CHECK (("product_versions"."operation"='create' and "product_versions"."previous_revision" is null and "product_versions"."revision"=1)
    or ("product_versions"."operation" in ('update','retire') and "product_versions"."previous_revision" is not null and "product_versions"."previous_revision">0 and "product_versions"."revision"="product_versions"."previous_revision"+1)),
	CONSTRAINT "product_version_fields" CHECK (length(trim("product_versions"."name")) between 1 and 250 and length(trim("product_versions"."code")) between 1 and 64 and "product_versions"."tag_count">=0
    and ("product_versions"."operation"='retire' or (length(trim("product_versions"."name"))<=200 and length("product_versions"."description")<=16000 and "product_versions"."tag_count"<=500
      and ("product_versions"."abbreviation" is null or length("product_versions"."abbreviation")<=64) and "product_versions"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'))
    and ("product_versions"."operation"<>'retire' or not "product_versions"."active"))
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tag_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "save_request_id" uuid;--> statement-breakpoint
ALTER TABLE "product_version_sample_categories" ADD CONSTRAINT "product_version_sample_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_sample_categories" ADD CONSTRAINT "product_version_category_parent_fk" FOREIGN KEY ("organization_id","product_id","revision") REFERENCES "public"."product_versions"("organization_id","product_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_sample_categories" ADD CONSTRAINT "product_version_category_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_tags" ADD CONSTRAINT "product_version_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_tags" ADD CONSTRAINT "product_version_tag_parent_fk" FOREIGN KEY ("organization_id","product_id","revision") REFERENCES "public"."product_versions"("organization_id","product_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_tags" ADD CONSTRAINT "product_version_tag_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_version_parent_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_version_template_fk" FOREIGN KEY ("organization_id","job_template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "product_tag_count" CHECK ("products"."tag_count" >= 0);--> statement-breakpoint
CREATE VIEW "public"."product_template_labels" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT template.organization_id,template.id AS template_id,template.code,version.name,version.kind,template.active
  FROM public.templates template JOIN LATERAL (
    SELECT name,kind FROM public.template_versions version
    WHERE version.organization_id=template.organization_id AND version.template_id=template.id AND version.status<>'building'
    ORDER BY (version.status='draft') DESC,version.number DESC LIMIT 1
  ) version ON true
  WHERE template.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
);
--> statement-breakpoint
REVOKE ALL ON product_template_labels FROM PUBLIC;
GRANT SELECT ON product_template_labels TO sampleify_app;

CREATE FUNCTION masters_guard_product_history() RETURNS trigger
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
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['product_versions','product_version_tags','product_version_sample_categories'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY product_history_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER product_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_product_history()',relation);
  END LOOP;
END $$;
GRANT INSERT ON product_version_tags TO sampleify_app;
CREATE POLICY product_tags_history_insert ON product_version_tags FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
--> statement-breakpoint
CREATE FUNCTION masters_assert_product_tags(target_organization uuid,target_product uuid,target_revision integer,check_current boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.product_versions; tag_count integer; minimum_position integer; maximum_position integer;
BEGIN
  SELECT * INTO version FROM public.product_versions
    WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product tag history is missing' USING ERRCODE='23514'; END IF;
  SELECT count(*),min(position),max(position) INTO tag_count,minimum_position,maximum_position FROM public.product_version_tags
    WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision;
  IF tag_count<>version.tag_count OR (tag_count>0 AND (minimum_position<>0 OR maximum_position<>tag_count-1)) THEN
    RAISE EXCEPTION 'Product tags require a complete ordered version' USING ERRCODE='23514';
  END IF;
  IF check_current AND (EXISTS (
    SELECT tag_id FROM public.product_tags WHERE organization_id=target_organization AND product_id=target_product
    EXCEPT SELECT tag_id FROM public.product_version_tags WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
  ) OR EXISTS (
    SELECT tag_id FROM public.product_version_tags WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
    EXCEPT SELECT tag_id FROM public.product_tags WHERE organization_id=target_organization AND product_id=target_product
  )) THEN RAISE EXCEPTION 'Current product tags must match their saved version' USING ERRCODE='23514'; END IF;
  IF version.operation='retire' AND EXISTS (SELECT 1 FROM public.product_versions
    WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision) AND (EXISTS (
    SELECT tag_id,position FROM public.product_version_tags WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
    EXCEPT SELECT tag_id,position FROM public.product_version_tags WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision
  ) OR EXISTS (
    SELECT tag_id,position FROM public.product_version_tags WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision
    EXCEPT SELECT tag_id,position FROM public.product_version_tags WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
  )) THEN RAISE EXCEPTION 'Product retirement preserves its last tag order' USING ERRCODE='23514'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_track_product() RETURNS trigger
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
    RAISE EXCEPTION 'Product writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New products start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Product writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    -- Check an earlier save before a second edit can replace its operational links.
    IF EXISTS (SELECT 1 FROM public.product_versions WHERE organization_id=OLD.organization_id AND product_id=OLD.id AND revision=OLD.revision) THEN
      PERFORM public.masters_assert_product_tags(OLD.organization_id,OLD.id,OLD.revision,true);
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND ((NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.job_template_id)
      IS DISTINCT FROM (OLD.code,OLD.name,OLD.description,OLD.abbreviation,OLD.job_template_id)
      OR NEW.tag_count<>(SELECT count(*) FROM public.product_tags WHERE organization_id=NEW.organization_id AND product_id=NEW.id)) THEN
      RAISE EXCEPTION 'Product retirement preserves its last settings and tags' USING ERRCODE='23514';
    END IF;
  END IF;
  IF operation<>'retire' AND NEW.job_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.templates template WHERE template.organization_id=NEW.organization_id AND template.id=NEW.job_template_id AND template.active
      AND EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND template_id=NEW.job_template_id AND status<>'building') FOR SHARE OF template;
    IF NOT FOUND THEN RAISE EXCEPTION 'Select an active template in this organization' USING ERRCODE='23514',CONSTRAINT='product_active_template'; END IF;
  END IF;
  INSERT INTO public.product_versions(organization_id,product_id,revision,request_id,previous_revision,operation,code,name,description,abbreviation,
    job_template_id,active,tag_count,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.job_template_id,NEW.active,NEW.tag_count,actor);
  INSERT INTO public.product_version_sample_categories(organization_id,product_id,revision,sample_category_id)
    SELECT NEW.organization_id,NEW.id,NEW.revision,sample_category_id FROM public.product_sample_categories
    WHERE organization_id=NEW.organization_id AND product_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER master_product_version AFTER INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION masters_track_product();
--> statement-breakpoint
CREATE FUNCTION masters_check_product_version_tags() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_product_tags(NEW.organization_id,NEW.product_id,NEW.revision,
    EXISTS (SELECT 1 FROM public.products WHERE organization_id=NEW.organization_id AND id=NEW.product_id AND revision=NEW.revision));
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_product_tags_complete AFTER INSERT ON product_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_product_version_tags();
--> statement-breakpoint
CREATE FUNCTION masters_guard_current_product_tags() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE record_organization uuid; record_product uuid; version public.product_versions;
BEGIN
  IF session_user<>'sampleify_app' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace product tag links through a new saved revision' USING ERRCODE='23514'; END IF;
  record_organization := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  record_product := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  SELECT history.* INTO version FROM public.products product JOIN public.product_versions history
    ON history.organization_id=product.organization_id AND history.product_id=product.id AND history.revision=product.revision AND history.request_id=product.save_request_id
    WHERE product.organization_id=record_organization AND product.id=record_product;
  IF version.product_id IS NULL OR version.created_transaction_id<>pg_current_xact_id() OR version.operation='retire'
    OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Product tag changes require their new active revision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM public.product_version_tags
    WHERE organization_id=record_organization AND product_id=record_product AND revision=version.revision AND tag_id=NEW.tag_id) THEN
    RAISE EXCEPTION 'A current product tag must belong to the new saved revision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER master_current_product_tag_guard BEFORE INSERT OR UPDATE OR DELETE ON product_tags
  FOR EACH ROW EXECUTE FUNCTION masters_guard_current_product_tags();
--> statement-breakpoint
CREATE FUNCTION masters_check_current_product_tags() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE record_organization uuid; record_product uuid; current_revision integer;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NULL; END IF;
  record_organization := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  record_product := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  SELECT revision INTO current_revision FROM public.products WHERE organization_id=record_organization AND id=record_product;
  PERFORM public.masters_assert_product_tags(record_organization,record_product,current_revision,true);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_current_product_tags_complete AFTER INSERT OR UPDATE OR DELETE ON product_tags
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_current_product_tags();
--> statement-breakpoint
-- Visible Product edits preserve these hidden links. Their owner/import path remains available.
REVOKE INSERT,UPDATE,DELETE ON product_sample_categories FROM sampleify_app;
REVOKE UPDATE ON product_tags FROM sampleify_app;
REVOKE DELETE ON products FROM sampleify_app;
REVOKE ALL ON FUNCTION masters_guard_product_history(),masters_assert_product_tags(uuid,uuid,integer,boolean),masters_track_product(),
  masters_check_product_version_tags(),masters_guard_current_product_tags(),masters_check_current_product_tags() FROM PUBLIC,sampleify_app,sampleify_report_worker;
