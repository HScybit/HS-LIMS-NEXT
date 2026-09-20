CREATE TABLE "method_version_users" (
	"organization_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "method_version_user_pk" PRIMARY KEY("organization_id","method_id","revision","user_id"),
	CONSTRAINT "method_version_user_position" UNIQUE("organization_id","method_id","revision","position"),
	CONSTRAINT "method_version_user_order" CHECK ("method_version_users"."position" between 0 and 499)
);
--> statement-breakpoint
CREATE TABLE "method_versions" (
	"organization_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"method_uuid" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"decimal_scale" integer NOT NULL,
	"parse_number" boolean NOT NULL,
	"active" boolean NOT NULL,
	"access_user_count" integer NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "method_version_pk" PRIMARY KEY("organization_id","method_id","revision"),
	CONSTRAINT "method_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "method_version_revision" CHECK (("method_versions"."operation"='create' and "method_versions"."previous_revision" is null and "method_versions"."revision"=1)
    or ("method_versions"."operation" in ('update','retire') and "method_versions"."previous_revision" is not null and "method_versions"."previous_revision">0 and "method_versions"."revision"="method_versions"."previous_revision"+1)),
	CONSTRAINT "method_version_fields" CHECK (length(trim("method_versions"."name")) between 1 and 200 and length("method_versions"."description")<=16000
    and length(trim("method_versions"."code")) between 1 and 64 and length(trim("method_versions"."method_uuid")) between 1 and 100
    and "method_versions"."decimal_scale" between 0 and 12 and "method_versions"."access_user_count" between 0 and 500
    and ("method_versions"."operation"<>'retire' or not "method_versions"."active"))
);
--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD COLUMN "access_user_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD COLUMN "save_request_id" uuid;--> statement-breakpoint
ALTER TABLE "method_version_users" ADD CONSTRAINT "method_version_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_users" ADD CONSTRAINT "method_version_user_parent_fk" FOREIGN KEY ("organization_id","method_id","revision") REFERENCES "public"."method_versions"("organization_id","method_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_users" ADD CONSTRAINT "method_version_user_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_versions" ADD CONSTRAINT "method_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_versions" ADD CONSTRAINT "method_version_parent_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_versions" ADD CONSTRAINT "method_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD CONSTRAINT "method_access_user_count" CHECK ("methods_of_analysis"."access_user_count" between 0 and 500);--> statement-breakpoint
CREATE VIEW "public"."method_access_user_labels" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT member.organization_id,person.id AS user_id,person.display_name,(member.active AND person.active) AS active
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
);
--> statement-breakpoint
REVOKE ALL ON method_access_user_labels FROM PUBLIC;
GRANT SELECT ON method_access_user_labels TO sampleify_app;

CREATE FUNCTION masters_guard_method_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.method_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Method history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='method_versions' THEN
    IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Method history requires the actual editor and transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.method_versions WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision;
    IF version.method_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR (session_user='sampleify_app' AND version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Method user history requires its new version transaction' USING ERRCODE='23514';
    END IF;
    IF version.operation<>'retire' THEN
      PERFORM 1 FROM public.memberships member JOIN public.users person ON person.id=member.user_id
        WHERE member.organization_id=NEW.organization_id AND member.user_id=NEW.user_id AND member.active AND person.active
        FOR SHARE OF member,person;
      IF NOT FOUND THEN RAISE EXCEPTION 'Select active users in this organization' USING ERRCODE='23514',CONSTRAINT='method_active_user'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['method_versions','method_version_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY method_history_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER method_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_method_history()',relation);
  END LOOP;
END $$;
GRANT INSERT ON method_version_users TO sampleify_app;
CREATE POLICY method_users_insert ON method_version_users FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
--> statement-breakpoint
CREATE FUNCTION masters_track_method() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Existing migration/fixture records do not acquire fabricated past actors.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Method writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 THEN RAISE EXCEPTION 'New methods start at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at,NEW.code) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at,OLD.code)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Method writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND (NEW.method_uuid,NEW.name,NEW.description,NEW.decimal_scale,NEW.parse_number,NEW.access_user_count)
      IS DISTINCT FROM (OLD.method_uuid,OLD.name,OLD.description,OLD.decimal_scale,OLD.parse_number,OLD.access_user_count) THEN
      RAISE EXCEPTION 'Method retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.method_versions(organization_id,method_id,revision,request_id,previous_revision,operation,code,method_uuid,name,description,
    decimal_scale,parse_number,active,access_user_count,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.method_uuid,NEW.name,NEW.description,NEW.decimal_scale,NEW.parse_number,NEW.active,NEW.access_user_count,actor);
  RETURN NEW;
END $$;
CREATE TRIGGER master_method_version AFTER INSERT OR UPDATE ON methods_of_analysis FOR EACH ROW EXECUTE FUNCTION masters_track_method();
--> statement-breakpoint
CREATE FUNCTION masters_check_method_users() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE user_count integer; minimum_position integer; maximum_position integer;
BEGIN
  SELECT count(*),min(position),max(position) INTO user_count,minimum_position,maximum_position FROM public.method_version_users
    WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision;
  IF user_count<>NEW.access_user_count OR (user_count>0 AND (minimum_position<>0 OR maximum_position<>user_count-1)) THEN
    RAISE EXCEPTION 'Method users require a complete ordered version' USING ERRCODE='23514';
  END IF;
  IF NEW.operation='retire' AND (EXISTS (
    SELECT user_id,position FROM public.method_version_users WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision
    EXCEPT SELECT user_id,position FROM public.method_version_users WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.previous_revision
  ) OR EXISTS (
    SELECT user_id,position FROM public.method_version_users WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.previous_revision
    EXCEPT SELECT user_id,position FROM public.method_version_users WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision
  )) THEN RAISE EXCEPTION 'Method retirement preserves its last users' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_method_users_complete AFTER INSERT ON method_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_method_users();
REVOKE DELETE ON methods_of_analysis FROM sampleify_app;
REVOKE ALL ON FUNCTION masters_guard_method_history(),masters_track_method(),masters_check_method_users() FROM PUBLIC,sampleify_app;
