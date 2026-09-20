CREATE TABLE "custom_field_definitions" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"auto_generated" text DEFAULT '' NOT NULL,
	"scheme" text DEFAULT '' NOT NULL,
	"nabl_display_term" text DEFAULT '' NOT NULL,
	"non_nabl_display_term" text DEFAULT '' NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"associated_with" text NOT NULL,
	"show_in_list" boolean DEFAULT false NOT NULL,
	"show_in_filter" boolean DEFAULT false NOT NULL,
	"allows_multiple" boolean DEFAULT false NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"padded_number" double precision DEFAULT 0 NOT NULL,
	"display_order" double precision DEFAULT 10000 NOT NULL,
	"date_format" text DEFAULT '' NOT NULL,
	"datetime_format" text DEFAULT '' NOT NULL,
	"generated_at" text DEFAULT 'on_init' NOT NULL,
	"associate_role_specific_users" boolean DEFAULT false NOT NULL,
	"associated_with_role_id" uuid,
	"splitter" text DEFAULT '/' NOT NULL,
	"filter_search_type" text DEFAULT '' NOT NULL,
	"show_in_dashboard" boolean DEFAULT false NOT NULL,
	"show_in_report" boolean DEFAULT false NOT NULL,
	"validate_uniqueness" boolean DEFAULT false NOT NULL,
	"hide_from_sample_creation" boolean DEFAULT false NOT NULL,
	"option_count" integer DEFAULT 0 NOT NULL,
	"edit_role_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"save_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "custom_field_revision" CHECK ("custom_field_definitions"."revision">0),
	CONSTRAINT "custom_field_text" CHECK (length("custom_field_definitions"."key") between 1 and 150 and "custom_field_definitions"."key" ~ '^[a-z0-9_]+$'
    and length("custom_field_definitions"."label")<=200 and length(trim("custom_field_definitions"."label"))>0 and length("custom_field_definitions"."description")<=16000
    and length("custom_field_definitions"."auto_generated")<=250 and length("custom_field_definitions"."scheme")<=5000
    and length("custom_field_definitions"."nabl_display_term")<=250 and length("custom_field_definitions"."non_nabl_display_term")<=250
    and length("custom_field_definitions"."splitter") between 1 and 20 and length("custom_field_definitions"."filter_search_type")<=40),
	CONSTRAINT "custom_field_types" CHECK ("custom_field_definitions"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')
    and "custom_field_definitions"."associated_with" in ('customer','decision_rule','equipment_log','equipment_service_log','instrument','moa_parameter','parameter','product','sample','sample_parameter','sample_product','users','vendor','method_of_analysis','equipment')
    and "custom_field_definitions"."generated_at" in ('on_demand','on_init','on_submit','on_transition','on_transition_success')),
	CONSTRAINT "custom_field_formats" CHECK ((("custom_field_definitions"."field_type"='date' and "custom_field_definitions"."date_format" in ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD','DD-MM-YYYY','MM-DD-YYYY','YYYY/MM/DD','DD.MM.YYYY','MM.DD.YYYY','DD MMM YYYY','MMM DD, YYYY','DD MMMM YYYY','MMMM DD, YYYY','MMMM Do YYYY','D MMM YYYY','Do MMMM YYYY'))
      or ("custom_field_definitions"."field_type"<>'date' and "custom_field_definitions"."date_format"=''))
    and (("custom_field_definitions"."field_type"='date_time' and "custom_field_definitions"."datetime_format" in ('DD/MM/YYYY HH:mm:ss','DD/MM/YYYY HH:mm','DD/MM/YYYY, HH:mm','DD/MM/YYYY hh:mm A','DD/MM/YYYY, hh:mm A','MM/DD/YYYY HH:mm','MM/DD/YYYY hh:mm A','YYYY-MM-DD HH:mm','YYYY-MM-DD hh:mm A','DD-MM-YYYY HH:mm','DD-MM-YYYY hh:mm A','DD MMM YYYY HH:mm','DD MMM YYYY hh:mm A','MMM DD, YYYY HH:mm','MMM DD, YYYY hh:mm A','DD MMMM YYYY HH:mm','DD MMMM YYYY hh:mm A','MMMM DD, YYYY HH:mm','MMMM DD, YYYY hh:mm A','MMMM Do YYYY | HH:mm','MMMM Do YYYY | hh:mm A','YYYY-MM-DD HH:mm:ss'))
      or ("custom_field_definitions"."field_type"<>'date_time' and "custom_field_definitions"."datetime_format"=''))),
	CONSTRAINT "custom_field_numbers" CHECK ("custom_field_definitions"."padded_number" between 0 and 1000 and "custom_field_definitions"."display_order" between 0 and 100000
    and "custom_field_definitions"."option_count" between 0 and 500 and "custom_field_definitions"."edit_role_count" between 0 and 500)
);
--> statement-breakpoint
CREATE TABLE "custom_field_version_edit_roles" (
	"organization_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"role_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "custom_field_edit_role_pk" PRIMARY KEY("organization_id","field_id","revision","role_id"),
	CONSTRAINT "custom_field_edit_role_position" UNIQUE("organization_id","field_id","revision","position"),
	CONSTRAINT "custom_field_edit_role_order" CHECK ("custom_field_version_edit_roles"."position" between 0 and 499)
);
--> statement-breakpoint
CREATE TABLE "custom_field_version_options" (
	"organization_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "custom_field_option_pk" PRIMARY KEY("organization_id","field_id","revision","id"),
	CONSTRAINT "custom_field_option_key" UNIQUE("organization_id","field_id","revision","key"),
	CONSTRAINT "custom_field_option_position" UNIQUE("organization_id","field_id","revision","position"),
	CONSTRAINT "custom_field_option_fields" CHECK ("custom_field_version_options"."position" between 0 and 499 and length("custom_field_version_options"."key") between 1 and 150
    and "custom_field_version_options"."key" ~ '^[A-Za-z0-9_]+$' and length("custom_field_version_options"."label")<=200 and length(trim("custom_field_version_options"."label"))>0)
);
--> statement-breakpoint
CREATE TABLE "custom_field_versions" (
	"organization_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"auto_generated" text DEFAULT '' NOT NULL,
	"scheme" text DEFAULT '' NOT NULL,
	"nabl_display_term" text DEFAULT '' NOT NULL,
	"non_nabl_display_term" text DEFAULT '' NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"associated_with" text NOT NULL,
	"show_in_list" boolean DEFAULT false NOT NULL,
	"show_in_filter" boolean DEFAULT false NOT NULL,
	"allows_multiple" boolean DEFAULT false NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"padded_number" double precision DEFAULT 0 NOT NULL,
	"display_order" double precision DEFAULT 10000 NOT NULL,
	"date_format" text DEFAULT '' NOT NULL,
	"datetime_format" text DEFAULT '' NOT NULL,
	"generated_at" text DEFAULT 'on_init' NOT NULL,
	"associate_role_specific_users" boolean DEFAULT false NOT NULL,
	"associated_with_role_id" uuid,
	"splitter" text DEFAULT '/' NOT NULL,
	"filter_search_type" text DEFAULT '' NOT NULL,
	"show_in_dashboard" boolean DEFAULT false NOT NULL,
	"show_in_report" boolean DEFAULT false NOT NULL,
	"validate_uniqueness" boolean DEFAULT false NOT NULL,
	"hide_from_sample_creation" boolean DEFAULT false NOT NULL,
	"option_count" integer DEFAULT 0 NOT NULL,
	"edit_role_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "custom_field_version_pk" PRIMARY KEY("organization_id","field_id","revision"),
	CONSTRAINT "custom_field_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "custom_field_version_revision" CHECK (("custom_field_versions"."operation"='create' and "custom_field_versions"."previous_revision" is null and "custom_field_versions"."revision"=1 and "custom_field_versions"."active")
    or ("custom_field_versions"."operation" in ('update','retire') and "custom_field_versions"."previous_revision">0 and "custom_field_versions"."previous_revision" is not null
      and "custom_field_versions"."revision"="custom_field_versions"."previous_revision"+1 and "custom_field_versions"."active"=("custom_field_versions"."operation"='update'))),
	CONSTRAINT "custom_field_version_text" CHECK (length("custom_field_versions"."key") between 1 and 150 and "custom_field_versions"."key" ~ '^[a-z0-9_]+$'
    and length("custom_field_versions"."label")<=200 and length(trim("custom_field_versions"."label"))>0 and length("custom_field_versions"."description")<=16000
    and length("custom_field_versions"."auto_generated")<=250 and length("custom_field_versions"."scheme")<=5000
    and length("custom_field_versions"."nabl_display_term")<=250 and length("custom_field_versions"."non_nabl_display_term")<=250
    and length("custom_field_versions"."splitter") between 1 and 20 and length("custom_field_versions"."filter_search_type")<=40),
	CONSTRAINT "custom_field_version_types" CHECK ("custom_field_versions"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')
    and "custom_field_versions"."associated_with" in ('customer','decision_rule','equipment_log','equipment_service_log','instrument','moa_parameter','parameter','product','sample','sample_parameter','sample_product','users','vendor','method_of_analysis','equipment')
    and "custom_field_versions"."generated_at" in ('on_demand','on_init','on_submit','on_transition','on_transition_success')),
	CONSTRAINT "custom_field_version_formats" CHECK ((("custom_field_versions"."field_type"='date' and "custom_field_versions"."date_format" in ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD','DD-MM-YYYY','MM-DD-YYYY','YYYY/MM/DD','DD.MM.YYYY','MM.DD.YYYY','DD MMM YYYY','MMM DD, YYYY','DD MMMM YYYY','MMMM DD, YYYY','MMMM Do YYYY','D MMM YYYY','Do MMMM YYYY'))
      or ("custom_field_versions"."field_type"<>'date' and "custom_field_versions"."date_format"=''))
    and (("custom_field_versions"."field_type"='date_time' and "custom_field_versions"."datetime_format" in ('DD/MM/YYYY HH:mm:ss','DD/MM/YYYY HH:mm','DD/MM/YYYY, HH:mm','DD/MM/YYYY hh:mm A','DD/MM/YYYY, hh:mm A','MM/DD/YYYY HH:mm','MM/DD/YYYY hh:mm A','YYYY-MM-DD HH:mm','YYYY-MM-DD hh:mm A','DD-MM-YYYY HH:mm','DD-MM-YYYY hh:mm A','DD MMM YYYY HH:mm','DD MMM YYYY hh:mm A','MMM DD, YYYY HH:mm','MMM DD, YYYY hh:mm A','DD MMMM YYYY HH:mm','DD MMMM YYYY hh:mm A','MMMM DD, YYYY HH:mm','MMMM DD, YYYY hh:mm A','MMMM Do YYYY | HH:mm','MMMM Do YYYY | hh:mm A','YYYY-MM-DD HH:mm:ss'))
      or ("custom_field_versions"."field_type"<>'date_time' and "custom_field_versions"."datetime_format"=''))),
	CONSTRAINT "custom_field_version_numbers" CHECK ("custom_field_versions"."padded_number" between 0 and 1000 and "custom_field_versions"."display_order" between 0 and 100000
    and "custom_field_versions"."option_count" between 0 and 500 and "custom_field_versions"."edit_role_count" between 0 and 500)
);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_associated_role_fk" FOREIGN KEY ("organization_id","associated_with_role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_version_edit_roles" ADD CONSTRAINT "custom_field_version_edit_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_version_edit_roles" ADD CONSTRAINT "custom_field_edit_role_version_fk" FOREIGN KEY ("organization_id","field_id","revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_version_edit_roles" ADD CONSTRAINT "custom_field_edit_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_version_options" ADD CONSTRAINT "custom_field_version_options_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_version_options" ADD CONSTRAINT "custom_field_option_version_fk" FOREIGN KEY ("organization_id","field_id","revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD CONSTRAINT "custom_field_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD CONSTRAINT "custom_field_version_parent_fk" FOREIGN KEY ("organization_id","field_id") REFERENCES "public"."custom_field_definitions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD CONSTRAINT "custom_field_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD CONSTRAINT "custom_field_previous_version_fk" FOREIGN KEY ("organization_id","field_id","previous_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD CONSTRAINT "custom_field_version_associated_role_fk" FOREIGN KEY ("organization_id","associated_with_role_id") REFERENCES "public"."roles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_active_key" ON "custom_field_definitions" USING btree ("organization_id","key") WHERE "custom_field_definitions"."active";--> statement-breakpoint
CREATE INDEX "custom_field_association_order" ON "custom_field_definitions" USING btree ("organization_id","associated_with","display_order","label","id") WHERE "custom_field_definitions"."active";
--> statement-breakpoint
CREATE FUNCTION masters_guard_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.custom_field_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Custom field history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='custom_field_versions' THEN
    IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Custom field history requires the actual editor and transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.revision;
    IF version.field_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR NOT EXISTS (SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.revision AND save_request_id=version.request_id)
      OR (session_user='sampleify_app' AND version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Custom field links require their new version transaction' USING ERRCODE='23514';
    END IF;
    IF NEW.position>=(CASE WHEN TG_TABLE_NAME='custom_field_version_options' THEN version.option_count ELSE version.edit_role_count END) THEN
      RAISE EXCEPTION 'Custom field link position exceeds its saved count' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_custom_field_links(target_organization uuid,target_field uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.custom_field_versions; link_count integer; minimum_position integer; maximum_position integer;
BEGIN
  SELECT * INTO version FROM public.custom_field_versions
    WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Custom field history is missing' USING ERRCODE='23514'; END IF;
  SELECT count(*),min(position),max(position) INTO link_count,minimum_position,maximum_position FROM public.custom_field_version_options
    WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision;
  IF link_count<>version.option_count OR (link_count>0 AND (minimum_position<>0 OR maximum_position<>link_count-1)) THEN
    RAISE EXCEPTION 'Custom field options require a complete ordered version' USING ERRCODE='23514';
  END IF;
  SELECT count(*),min(position),max(position) INTO link_count,minimum_position,maximum_position FROM public.custom_field_version_edit_roles
    WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision;
  IF link_count<>version.edit_role_count OR (link_count>0 AND (minimum_position<>0 OR maximum_position<>link_count-1)) THEN
    RAISE EXCEPTION 'Custom field roles require a complete ordered version' USING ERRCODE='23514';
  END IF;
  IF version.operation='retire' AND (EXISTS (
    SELECT id,key,label,position FROM public.custom_field_version_options WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision
    EXCEPT SELECT id,key,label,position FROM public.custom_field_version_options WHERE organization_id=target_organization AND field_id=target_field AND revision=version.previous_revision
  ) OR EXISTS (
    SELECT id,key,label,position FROM public.custom_field_version_options WHERE organization_id=target_organization AND field_id=target_field AND revision=version.previous_revision
    EXCEPT SELECT id,key,label,position FROM public.custom_field_version_options WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision
  ) OR EXISTS (
    SELECT role_id,position FROM public.custom_field_version_edit_roles WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision
    EXCEPT SELECT role_id,position FROM public.custom_field_version_edit_roles WHERE organization_id=target_organization AND field_id=target_field AND revision=version.previous_revision
  ) OR EXISTS (
    SELECT role_id,position FROM public.custom_field_version_edit_roles WHERE organization_id=target_organization AND field_id=target_field AND revision=version.previous_revision
    EXCEPT SELECT role_id,position FROM public.custom_field_version_edit_roles WHERE organization_id=target_organization AND field_id=target_field AND revision=target_revision
  )) THEN RAISE EXCEPTION 'Custom field retirement preserves its last options and roles' USING ERRCODE='23514'; END IF;
END $$;

--> statement-breakpoint
CREATE FUNCTION masters_track_custom_field() RETURNS trigger
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
    IF NOT NEW.active AND ((NEW.key,NEW.label,NEW.description,NEW.auto_generated,NEW.scheme,NEW.nabl_display_term,NEW.non_nabl_display_term,NEW.field_type,NEW.associated_with,NEW.show_in_list,NEW.show_in_filter,NEW.allows_multiple,NEW.is_required,NEW.padded_number,NEW.display_order,NEW.date_format,NEW.datetime_format,NEW.generated_at,NEW.associate_role_specific_users,NEW.associated_with_role_id,NEW.splitter,NEW.filter_search_type,NEW.show_in_dashboard,NEW.show_in_report,NEW.validate_uniqueness,NEW.hide_from_sample_creation,NEW.option_count,NEW.edit_role_count) IS DISTINCT FROM (OLD.key,OLD.label,OLD.description,OLD.auto_generated,OLD.scheme,OLD.nabl_display_term,OLD.non_nabl_display_term,OLD.field_type,OLD.associated_with,OLD.show_in_list,OLD.show_in_filter,OLD.allows_multiple,OLD.is_required,OLD.padded_number,OLD.display_order,OLD.date_format,OLD.datetime_format,OLD.generated_at,OLD.associate_role_specific_users,OLD.associated_with_role_id,OLD.splitter,OLD.filter_search_type,OLD.show_in_dashboard,OLD.show_in_report,OLD.validate_uniqueness,OLD.hide_from_sample_creation,OLD.option_count,OLD.edit_role_count)) THEN
      RAISE EXCEPTION 'Custom field retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.custom_field_versions(organization_id,field_id,revision,request_id,previous_revision,operation,key,label,description,auto_generated,scheme,nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation,option_count,edit_role_count,active,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,NEW.key,NEW.label,NEW.description,NEW.auto_generated,NEW.scheme,NEW.nabl_display_term,NEW.non_nabl_display_term,NEW.field_type,NEW.associated_with,NEW.show_in_list,NEW.show_in_filter,NEW.allows_multiple,NEW.is_required,NEW.padded_number,NEW.display_order,NEW.date_format,NEW.datetime_format,NEW.generated_at,NEW.associate_role_specific_users,NEW.associated_with_role_id,NEW.splitter,NEW.filter_search_type,NEW.show_in_dashboard,NEW.show_in_report,NEW.validate_uniqueness,NEW.hide_from_sample_creation,NEW.option_count,NEW.edit_role_count,NEW.active,actor);
  RETURN NEW;
END $$;
CREATE TRIGGER master_custom_field_version AFTER INSERT OR UPDATE OR DELETE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION masters_track_custom_field();
--> statement-breakpoint
CREATE FUNCTION masters_check_custom_field_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_custom_field_links(NEW.organization_id,NEW.field_id,NEW.revision);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_custom_field_links_complete AFTER INSERT ON custom_field_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_custom_field_links();
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['custom_field_definitions','custom_field_versions','custom_field_version_options','custom_field_version_edit_roles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    IF relation<>'custom_field_definitions' THEN
      EXECUTE format('CREATE TRIGGER custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION masters_guard_custom_field_history()',relation);
    END IF;
    IF relation<>'custom_field_versions' THEN
      EXECUTE format('GRANT INSERT ON %I TO sampleify_app',relation);
      EXECUTE format('CREATE POLICY custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
        (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))',relation);
    END IF;
  END LOOP;
END $$;
GRANT UPDATE ON custom_field_definitions TO sampleify_app;
CREATE POLICY custom_field_update ON custom_field_definitions FOR UPDATE TO sampleify_app
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
REVOKE ALL ON FUNCTION masters_guard_custom_field_history(),masters_assert_custom_field_links(uuid,uuid,integer),
  masters_track_custom_field(),masters_check_custom_field_links() FROM PUBLIC,sampleify_app,sampleify_report_worker;
