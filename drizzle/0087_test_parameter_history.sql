CREATE TABLE "parameter_uncertainty_cells" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"row_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"text_value" text NOT NULL,
	CONSTRAINT "parameter_uncertainty_cell_pk" PRIMARY KEY("organization_id","parameter_id","revision","row_id","column_id"),
	CONSTRAINT "parameter_uncertainty_cell_length" CHECK (length("parameter_uncertainty_cells"."text_value")<=2000)
);
--> statement-breakpoint
CREATE TABLE "parameter_uncertainty_columns" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "parameter_uncertainty_column_pk" PRIMARY KEY("organization_id","parameter_id","revision","id"),
	CONSTRAINT "parameter_uncertainty_column_position" UNIQUE("organization_id","parameter_id","revision","position"),
	CONSTRAINT "parameter_uncertainty_column_shape" CHECK ("parameter_uncertainty_columns"."position" between 0 and 31 and length(trim("parameter_uncertainty_columns"."title")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "parameter_uncertainty_rows" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "parameter_uncertainty_row_pk" PRIMARY KEY("organization_id","parameter_id","revision","id"),
	CONSTRAINT "parameter_uncertainty_row_position" UNIQUE("organization_id","parameter_id","revision","position"),
	CONSTRAINT "parameter_uncertainty_row_shape" CHECK ("parameter_uncertainty_rows"."position" between 0 and 499)
);
--> statement-breakpoint
CREATE TABLE "test_parameter_version_methods" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"method_id" uuid NOT NULL,
	"is_default" boolean NOT NULL,
	CONSTRAINT "test_parameter_version_method_pk" PRIMARY KEY("organization_id","parameter_id","revision","method_id")
);
--> statement-breakpoint
CREATE TABLE "test_parameter_versions" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"master_key" text NOT NULL,
	"scheme_abbreviation" text NOT NULL,
	"display_order" integer NOT NULL,
	"active" boolean NOT NULL,
	"laboratory_id" uuid,
	"measurement_unit_id" uuid,
	"default_scale" integer NOT NULL,
	"has_uncertainty" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "test_parameter_version_pk" PRIMARY KEY("organization_id","parameter_id","revision"),
	CONSTRAINT "test_parameter_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "test_parameter_version_revision" CHECK (("test_parameter_versions"."operation"='create' and "test_parameter_versions"."previous_revision" is null and "test_parameter_versions"."revision"=1)
    or ("test_parameter_versions"."operation" in ('update','retire') and "test_parameter_versions"."previous_revision" is not null and "test_parameter_versions"."previous_revision">0 and "test_parameter_versions"."revision"="test_parameter_versions"."previous_revision"+1)),
	CONSTRAINT "test_parameter_version_fields" CHECK (length(trim("test_parameter_versions"."name")) between 1 and 200 and length("test_parameter_versions"."description")<=16000
    and length(trim("test_parameter_versions"."code")) between 1 and 64 and length(trim("test_parameter_versions"."master_key")) between 1 and 64
    and length(trim("test_parameter_versions"."scheme_abbreviation")) between 1 and 64 and "test_parameter_versions"."display_order">=0 and "test_parameter_versions"."default_scale" between 0 and 12
    and ("test_parameter_versions"."operation"<>'retire' or not "test_parameter_versions"."active"))
);
--> statement-breakpoint
ALTER TABLE "test_parameters" ADD COLUMN "uncertainty_configured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_parameters" ADD COLUMN "save_request_id" uuid;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_cells" ADD CONSTRAINT "parameter_uncertainty_cells_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_cells" ADD CONSTRAINT "parameter_uncertainty_cell_row_fk" FOREIGN KEY ("organization_id","parameter_id","revision","row_id") REFERENCES "public"."parameter_uncertainty_rows"("organization_id","parameter_id","revision","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_cells" ADD CONSTRAINT "parameter_uncertainty_cell_column_fk" FOREIGN KEY ("organization_id","parameter_id","revision","column_id") REFERENCES "public"."parameter_uncertainty_columns"("organization_id","parameter_id","revision","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_columns" ADD CONSTRAINT "parameter_uncertainty_columns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_columns" ADD CONSTRAINT "parameter_uncertainty_column_version_fk" FOREIGN KEY ("organization_id","parameter_id","revision") REFERENCES "public"."test_parameter_versions"("organization_id","parameter_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_rows" ADD CONSTRAINT "parameter_uncertainty_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_uncertainty_rows" ADD CONSTRAINT "parameter_uncertainty_row_version_fk" FOREIGN KEY ("organization_id","parameter_id","revision") REFERENCES "public"."test_parameter_versions"("organization_id","parameter_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_version_methods" ADD CONSTRAINT "test_parameter_version_methods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_version_methods" ADD CONSTRAINT "test_parameter_version_method_parent_fk" FOREIGN KEY ("organization_id","parameter_id","revision") REFERENCES "public"."test_parameter_versions"("organization_id","parameter_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_version_methods" ADD CONSTRAINT "test_parameter_version_method_fk" FOREIGN KEY ("organization_id","method_id") REFERENCES "public"."methods_of_analysis"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "test_parameter_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "test_parameter_version_parent_fk" FOREIGN KEY ("organization_id","parameter_id") REFERENCES "public"."test_parameters"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "test_parameter_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "test_parameter_version_lab_fk" FOREIGN KEY ("organization_id","laboratory_id") REFERENCES "public"."laboratories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "test_parameter_version_unit_fk" FOREIGN KEY ("organization_id","measurement_unit_id") REFERENCES "public"."measurement_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_parameter_version_default_method" ON "test_parameter_version_methods" USING btree ("organization_id","parameter_id","revision") WHERE "test_parameter_version_methods"."is_default";
--> statement-breakpoint
-- Only actual subsequent writes create history; no past editor is invented.
CREATE FUNCTION masters_guard_parameter_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Parameter history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='test_parameter_versions' THEN
    IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Parameter history requires the actual editor and transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.test_parameter_versions WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision;
    IF version.parameter_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR (session_user='sampleify_app' AND version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
      RAISE EXCEPTION 'Parameter child history requires its new version transaction' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='parameter_uncertainty_cells' THEN
      IF EXISTS (SELECT 1 FROM public.parameter_uncertainty_columns
        WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision AND id=NEW.column_id AND position=0) THEN
        RAISE EXCEPTION 'Uncertainty serial numbers are derived from row order' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['test_parameter_versions','test_parameter_version_methods','parameter_uncertainty_columns','parameter_uncertainty_rows','parameter_uncertainty_cells'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY parameter_history_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
      AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER parameter_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_parameter_history()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['parameter_uncertainty_columns','parameter_uncertainty_rows','parameter_uncertainty_cells'] LOOP
    EXECUTE format('GRANT INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE POLICY parameter_grid_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_track_test_parameter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Migration/fixture owners maintain their explicit provenance separately.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF NOT public.app_has_permission('masters.manage') OR actor IS NULL
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Parameter writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 THEN RAISE EXCEPTION 'New parameters start at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at,NEW.code) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at,OLD.code)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Parameter writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
  END IF;
  INSERT INTO public.test_parameter_versions(organization_id,parameter_id,revision,request_id,previous_revision,operation,
    code,name,description,master_key,scheme_abbreviation,display_order,active,laboratory_id,measurement_unit_id,default_scale,has_uncertainty,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.description,NEW.master_key,NEW.scheme_abbreviation,NEW.display_order,NEW.active,NEW.laboratory_id,NEW.measurement_unit_id,NEW.default_scale,NEW.uncertainty_configured,actor);
  INSERT INTO public.test_parameter_version_methods(organization_id,parameter_id,revision,method_id,is_default)
    SELECT NEW.organization_id,NEW.id,NEW.revision,method_id,is_default FROM public.parameter_methods
    WHERE organization_id=NEW.organization_id AND test_parameter_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER master_parameter_version AFTER INSERT OR UPDATE ON test_parameters FOR EACH ROW EXECUTE FUNCTION masters_track_test_parameter();
--> statement-breakpoint
CREATE FUNCTION masters_check_parameter_grid() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE column_count integer; row_count integer; cell_count integer; text_bytes bigint; minimum_position integer; maximum_position integer;
BEGIN
  SELECT count(*),min(position),max(position),coalesce(sum(octet_length(title)),0) INTO column_count,minimum_position,maximum_position,text_bytes
    FROM public.parameter_uncertainty_columns WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision;
  IF NEW.has_uncertainty AND (column_count<2 OR column_count>32 OR minimum_position<>0 OR maximum_position<>column_count-1) THEN
    RAISE EXCEPTION 'Uncertainty columns require a complete ordered header' USING ERRCODE='23514';
  END IF;
  SELECT count(*),min(position),max(position) INTO row_count,minimum_position,maximum_position
    FROM public.parameter_uncertainty_rows WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision;
  IF NEW.has_uncertainty AND (row_count<1 OR row_count>500 OR minimum_position<>0 OR maximum_position<>row_count-1) THEN
    RAISE EXCEPTION 'Uncertainty rows require a complete sequence' USING ERRCODE='23514';
  END IF;
  SELECT count(*),text_bytes+coalesce(sum(octet_length(text_value)),0) INTO cell_count,text_bytes
    FROM public.parameter_uncertainty_cells WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision;
  IF (NEW.has_uncertainty AND cell_count<>row_count*(column_count-1)) OR (NOT NEW.has_uncertainty AND column_count+row_count+cell_count<>0) OR text_bytes>1048576 THEN
    RAISE EXCEPTION 'Uncertainty cells must match the bounded version grid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_parameter_grid_complete AFTER INSERT ON test_parameter_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_parameter_grid();
--> statement-breakpoint
REVOKE DELETE ON test_parameters FROM sampleify_app;
REVOKE ALL ON FUNCTION masters_track_test_parameter(),masters_guard_parameter_history(),masters_check_parameter_grid() FROM PUBLIC,sampleify_app;
