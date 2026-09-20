CREATE TABLE "custom_field_lookup_lines" (
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"original_line_id" text NOT NULL,
	"position" integer NOT NULL,
	"label_kind" text NOT NULL,
	"label_text" text,
	"label_number" double precision,
	"label_boolean" boolean,
	CONSTRAINT "custom_lookup_line_pk" PRIMARY KEY("organization_id","source_id","revision","original_line_id"),
	CONSTRAINT "custom_lookup_line_position" UNIQUE("organization_id","source_id","revision","position"),
	CONSTRAINT "custom_lookup_line_shape" CHECK (length(trim("custom_field_lookup_lines"."original_line_id"))>0 and length("custom_field_lookup_lines"."original_line_id")<=200 and "custom_field_lookup_lines"."position" between 0 and 9999
    and num_nonnulls("custom_field_lookup_lines"."label_text","custom_field_lookup_lines"."label_number","custom_field_lookup_lines"."label_boolean")=1
    and (("custom_field_lookup_lines"."label_kind"='text' and "custom_field_lookup_lines"."label_text" is not null and length("custom_field_lookup_lines"."label_text")<=16000)
      or ("custom_field_lookup_lines"."label_kind"='number' and "custom_field_lookup_lines"."label_number" is not null and "custom_field_lookup_lines"."label_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("custom_field_lookup_lines"."label_kind"='boolean' and "custom_field_lookup_lines"."label_boolean" is not null)))
);
--> statement-breakpoint
CREATE TABLE "custom_field_lookup_sources" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"source_system" text DEFAULT 'meteor' NOT NULL,
	"original_source_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"line_count" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_lookup_source_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "custom_lookup_original_source_key" UNIQUE("organization_id","source_system","original_source_id"),
	CONSTRAINT "custom_lookup_source_shape" CHECK ("custom_field_lookup_sources"."source_system"='meteor' and length(trim("custom_field_lookup_sources"."original_source_id"))>0
    and length("custom_field_lookup_sources"."original_source_id")<=200 and length("custom_field_lookup_sources"."name")<=16000
    and "custom_field_lookup_sources"."revision">0 and "custom_field_lookup_sources"."line_count" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "custom_field_lookup_versions" (
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"name" text NOT NULL,
	"line_count" integer NOT NULL,
	"observed_by" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "custom_lookup_version_pk" PRIMARY KEY("organization_id","source_id","revision"),
	CONSTRAINT "custom_lookup_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "custom_lookup_version_shape" CHECK ("custom_field_lookup_versions"."previous_revision">=0 and "custom_field_lookup_versions"."revision"="custom_field_lookup_versions"."previous_revision"+1
    and length("custom_field_lookup_versions"."name")<=16000 and "custom_field_lookup_versions"."line_count" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "lookup_source_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD COLUMN "lookup_source_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_field_lookup_lines" ADD CONSTRAINT "custom_lookup_line_version_fk" FOREIGN KEY ("organization_id","source_id","revision") REFERENCES "public"."custom_field_lookup_versions"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_lookup_sources" ADD CONSTRAINT "custom_field_lookup_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_lookup_versions" ADD CONSTRAINT "custom_lookup_version_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."custom_field_lookup_sources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_lookup_versions" ADD CONSTRAINT "custom_lookup_observer_fk" FOREIGN KEY ("organization_id","observed_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_lookup_source_fk" FOREIGN KEY ("organization_id","lookup_source_id") REFERENCES "public"."custom_field_lookup_sources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD CONSTRAINT "custom_field_version_lookup_source_fk" FOREIGN KEY ("organization_id","lookup_source_id") REFERENCES "public"."custom_field_lookup_sources"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION masters_assert_lookup_lines(target_organization uuid,target_source uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.custom_field_lookup_versions; total integer; first_position integer; last_position integer; raw_bytes bigint;
BEGIN
  SELECT * INTO version FROM public.custom_field_lookup_versions
    WHERE organization_id=target_organization AND source_id=target_source AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lookup observation is missing' USING ERRCODE='23514'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(octet_length(original_line_id)+coalesce(octet_length(label_text),8)),0)
    INTO total,first_position,last_position,raw_bytes FROM public.custom_field_lookup_lines
    WHERE organization_id=target_organization AND source_id=target_source AND revision=target_revision;
  IF total<>version.line_count OR (total>0 AND (first_position<>0 OR last_position<>total-1)) THEN
    RAISE EXCEPTION 'Lookup observation requires every ordered line' USING ERRCODE='23514',CONSTRAINT='custom_lookup_complete';
  END IF;
  IF raw_bytes+octet_length(version.name)>8388608 THEN
    RAISE EXCEPTION 'Lookup observation exceeds the stored byte limit' USING ERRCODE='23514',CONSTRAINT='custom_lookup_bytes';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_lookup_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.custom_field_lookup_versions; source public.custom_field_lookup_sources;
  actor uuid := nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Lookup observations are immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO source FROM public.custom_field_lookup_sources
    WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
  IF TG_TABLE_NAME='custom_field_lookup_versions' THEN
    IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.observed_at<>transaction_timestamp()
      OR actor IS NULL OR NEW.observed_by IS DISTINCT FROM actor OR source.id IS NULL
      OR (NEW.revision,NEW.request_id,NEW.name,NEW.line_count) IS DISTINCT FROM (source.revision,source.request_id,source.name,source.line_count) THEN
      RAISE EXCEPTION 'Lookup history requires the actual observation transaction and source head' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.custom_field_lookup_versions
      WHERE organization_id=NEW.organization_id AND source_id=NEW.source_id AND revision=NEW.revision;
    IF version.source_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR source.id IS NULL OR (source.revision,source.request_id) IS DISTINCT FROM (version.revision,version.request_id)
      OR actor IS NULL OR version.observed_by IS DISTINCT FROM actor OR NEW.position>=version.line_count THEN
      RAISE EXCEPTION 'Lookup lines require their new observation transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_track_lookup_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preserve lookup source identities and observations' USING ERRCODE='55000'; END IF;
  IF actor IS NULL OR (session_user='sampleify_app' AND (NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid)) THEN
    RAISE EXCEPTION 'Lookup observations require master management and the actual observer' USING ERRCODE='42501';
  END IF;
  IF NEW.updated_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Lookup updates require their actual transaction time' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.created_at<>transaction_timestamp() THEN
      RAISE EXCEPTION 'Lookup observations start at revision one in their creation transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.source_system,NEW.original_source_id,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.source_system,OLD.original_source_id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'Lookup observations preserve source identity and advance one revision' USING ERRCODE='23514';
    END IF;
    PERFORM public.masters_assert_lookup_lines(OLD.organization_id,OLD.id,OLD.revision);
  END IF;
  INSERT INTO public.custom_field_lookup_versions(organization_id,source_id,revision,previous_revision,request_id,name,line_count,observed_by)
    VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.revision-1,NEW.request_id,NEW.name,NEW.line_count,actor);
  RETURN NEW;
END $$;
CREATE TRIGGER custom_lookup_observation AFTER INSERT OR UPDATE OR DELETE ON custom_field_lookup_sources
  FOR EACH ROW EXECUTE FUNCTION masters_track_lookup_source();
--> statement-breakpoint
CREATE FUNCTION masters_check_lookup_lines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_lookup_lines(NEW.organization_id,NEW.source_id,NEW.revision);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER custom_lookup_lines_complete AFTER INSERT ON custom_field_lookup_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_lookup_lines();
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['custom_field_lookup_sources','custom_field_lookup_versions','custom_field_lookup_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE POLICY custom_lookup_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    IF relation<>'custom_field_lookup_sources' THEN
      EXECUTE format('CREATE TRIGGER custom_lookup_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION masters_guard_lookup_history()',relation);
    END IF;
    IF relation<>'custom_field_lookup_versions' THEN
      EXECUTE format('GRANT INSERT ON %I TO sampleify_app',relation);
      EXECUTE format('CREATE POLICY custom_lookup_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
        (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))',relation);
    END IF;
  END LOOP;
END $$;
GRANT UPDATE ON custom_field_lookup_sources TO sampleify_app;
CREATE POLICY custom_lookup_update ON custom_field_lookup_sources FOR UPDATE TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
REVOKE ALL ON FUNCTION masters_assert_lookup_lines(uuid,uuid,integer),masters_guard_lookup_history(),masters_track_lookup_source(),masters_check_lookup_lines()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_track_custom_field() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retire custom fields to preserve history' USING ERRCODE='55000'; END IF;
  IF actor IS NULL OR (session_user='sampleify_app' AND (NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid)) THEN
    RAISE EXCEPTION 'Master management permission and actual editor required' USING ERRCODE='42501';
  END IF;
  IF NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Custom field writes require the actual transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active OR NEW.created_at<>transaction_timestamp() THEN
      RAISE EXCEPTION 'New custom fields start active at revision one with their creation time' USING ERRCODE='23514';
    END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Custom field writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    PERFORM public.masters_assert_custom_field_links(OLD.organization_id,OLD.id,OLD.revision);
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND ((NEW.key,NEW.label,NEW.description,NEW.auto_generated,NEW.scheme,NEW.nabl_display_term,NEW.non_nabl_display_term,NEW.field_type,NEW.associated_with,NEW.show_in_list,NEW.show_in_filter,NEW.allows_multiple,NEW.is_required,NEW.padded_number,NEW.display_order,NEW.date_format,NEW.datetime_format,NEW.generated_at,NEW.associate_role_specific_users,NEW.associated_with_role_id,NEW.splitter,NEW.filter_search_type,NEW.show_in_dashboard,NEW.show_in_report,NEW.validate_uniqueness,NEW.hide_from_sample_creation,NEW.option_count,NEW.edit_role_count,NEW.lookup_source_id) IS DISTINCT FROM (OLD.key,OLD.label,OLD.description,OLD.auto_generated,OLD.scheme,OLD.nabl_display_term,OLD.non_nabl_display_term,OLD.field_type,OLD.associated_with,OLD.show_in_list,OLD.show_in_filter,OLD.allows_multiple,OLD.is_required,OLD.padded_number,OLD.display_order,OLD.date_format,OLD.datetime_format,OLD.generated_at,OLD.associate_role_specific_users,OLD.associated_with_role_id,OLD.splitter,OLD.filter_search_type,OLD.show_in_dashboard,OLD.show_in_report,OLD.validate_uniqueness,OLD.hide_from_sample_creation,OLD.option_count,OLD.edit_role_count,OLD.lookup_source_id)) THEN
      RAISE EXCEPTION 'Custom field retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.custom_field_versions(organization_id,field_id,revision,request_id,previous_revision,operation,key,label,description,auto_generated,scheme,nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation,option_count,edit_role_count,active,saved_by,lookup_source_id)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,NEW.key,NEW.label,NEW.description,NEW.auto_generated,NEW.scheme,NEW.nabl_display_term,NEW.non_nabl_display_term,NEW.field_type,NEW.associated_with,NEW.show_in_list,NEW.show_in_filter,NEW.allows_multiple,NEW.is_required,NEW.padded_number,NEW.display_order,NEW.date_format,NEW.datetime_format,NEW.generated_at,NEW.associate_role_specific_users,NEW.associated_with_role_id,NEW.splitter,NEW.filter_search_type,NEW.show_in_dashboard,NEW.show_in_report,NEW.validate_uniqueness,NEW.hide_from_sample_creation,NEW.option_count,NEW.edit_role_count,NEW.active,actor,NEW.lookup_source_id);
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE VIEW user_custom_field_versions WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,field_id,revision,option_count,key,label,description,auto_generated,scheme,
    nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,
    allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,
    associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,
    show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation,lookup_source_id
  FROM public.custom_field_versions
  WHERE associated_with='users' AND organization_id=(SELECT public.users_directory_organization());
