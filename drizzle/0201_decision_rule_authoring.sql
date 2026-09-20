-- Decision Rules schema redesign (step 6). This table has never been used by any
-- application code (only reviewed, per .local-migration/PENDING_DECISIONS.md Q16),
-- so reshaping it now is safe. PERN treats Sample Category as a true multi-select
-- and enforces active-rule uniqueness on (product,parameter,method) alone,
-- independent of category (Q16, confirmed 2026-09-18) -- incompatible with the
-- original single sample_category_id column and its scope-key unique constraint,
-- which are replaced here by a join table and a partial active-only index.
-- PERN's own field list (test-group hierarchy, formula metadata, instrument
-- refs) is added; the actual formula EVALUATION engine belongs to step 8/9
-- (Datasheets/results), not this master -- these columns are validated
-- structurally (required-if-flag, length, unique variable keys) and stored,
-- not interpreted, matching PERN's own decision-rule save-time validation.
CREATE TABLE "decision_rule_formula_variables" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"decision_rule_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "decision_rule_formula_variable_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "decision_rule_formula_variable_key" UNIQUE("organization_id","decision_rule_id","key"),
	CONSTRAINT "decision_rule_formula_variable_fields" CHECK ("decision_rule_formula_variables"."key" ~ '^[A-Za-z0-9_]+$' and length("decision_rule_formula_variables"."key") between 1 and 64
    and length(trim("decision_rule_formula_variables"."label")) between 1 and 200 and "decision_rule_formula_variables"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "decision_rule_sample_categories" (
	"organization_id" uuid NOT NULL,
	"decision_rule_id" uuid NOT NULL,
	"sample_category_id" uuid NOT NULL,
	CONSTRAINT "decision_rule_sample_categories_organization_id_decision_rule_id_sample_category_id_pk" PRIMARY KEY("organization_id","decision_rule_id","sample_category_id")
);
--> statement-breakpoint
CREATE TABLE "decision_rule_instruments" (
	"organization_id" uuid NOT NULL,
	"decision_rule_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	CONSTRAINT "decision_rule_instruments_organization_id_decision_rule_id_instrument_id_pk" PRIMARY KEY("organization_id","decision_rule_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "decision_rule_versions" (
	"organization_id" uuid NOT NULL,
	"decision_rule_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"parent_decision_rule_id" uuid,
	"is_test_group_parent" boolean NOT NULL,
	"test_group_name" text,
	"test_group_uid" text,
	"product_id" uuid NOT NULL,
	"test_parameter_id" uuid NOT NULL,
	"method_id" uuid,
	"template_id" uuid,
	"cutoff_value" numeric NOT NULL,
	"greater_than_text" text,
	"less_than_text" text,
	"minimum_text" text,
	"maximum_text" text,
	"unit_of_measure" text,
	"is_nabl" boolean NOT NULL,
	"minimum_size" text,
	"estimated_time_in_days" numeric NOT NULL,
	"estimated_charges" numeric NOT NULL,
	"express_time_in_days" numeric NOT NULL,
	"express_charges" numeric NOT NULL,
	"result_representation" text,
	"default_narration" text,
	"detectable_upper_limit" numeric,
	"detectable_lower_limit" numeric,
	"detectable_upper_limit_text" text,
	"detectable_lower_limit_text" text,
	"show_detectable_limit_text" boolean NOT NULL,
	"show_standard_limit_text" boolean NOT NULL,
	"conformance_limit" numeric,
	"discipline" text,
	"rule_group" text,
	"unique_key" text,
	"has_formula" boolean NOT NULL,
	"formula" text,
	"formula_text" text,
	"has_derived_formula" boolean NOT NULL,
	"custom_formula" text,
	"formula_expression" text,
	"active" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "decision_rule_version_pk" PRIMARY KEY("organization_id","decision_rule_id","revision"),
	CONSTRAINT "decision_rule_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "decision_rule_version_revision" CHECK (("decision_rule_versions"."operation"='create' and "decision_rule_versions"."previous_revision" is null and "decision_rule_versions"."revision"=1)
    or ("decision_rule_versions"."operation" in ('update','retire') and "decision_rule_versions"."previous_revision" is not null and "decision_rule_versions"."previous_revision">0 and "decision_rule_versions"."revision"="decision_rule_versions"."previous_revision"+1))
);
--> statement-breakpoint
ALTER TABLE "decision_rules" DROP CONSTRAINT "decision_rule_scope_key";--> statement-breakpoint
ALTER TABLE "decision_rules" DROP CONSTRAINT "decision_rules_metadata";--> statement-breakpoint
ALTER TABLE "decision_rules" DROP CONSTRAINT "decision_rules_organization_id_sample_category_id_sample_categories_organization_id_id_fk";
--> statement-breakpoint
ALTER TABLE "decision_rules" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "save_request_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "parent_decision_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "is_test_group_parent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "test_group_name" text;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "test_group_uid" text;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "has_formula" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "formula" text;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "formula_text" text;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "has_derived_formula" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "custom_formula" text;--> statement-breakpoint
ALTER TABLE "decision_rules" ADD COLUMN "formula_expression" text;--> statement-breakpoint
ALTER TABLE "decision_rule_formula_variables" ADD CONSTRAINT "decision_rule_formula_variables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_formula_variables" ADD CONSTRAINT "decision_rule_formula_variable_rule_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_sample_categories" ADD CONSTRAINT "decision_rule_sample_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_sample_categories" ADD CONSTRAINT "decision_rule_sample_category_rule_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_sample_categories" ADD CONSTRAINT "decision_rule_sample_category_category_fk" FOREIGN KEY ("organization_id","sample_category_id") REFERENCES "public"."sample_categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_instruments" ADD CONSTRAINT "decision_rule_instruments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_instruments" ADD CONSTRAINT "decision_rule_instrument_rule_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_instruments" ADD CONSTRAINT "decision_rule_instrument_instrument_fk" FOREIGN KEY ("organization_id","instrument_id") REFERENCES "public"."instruments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_versions" ADD CONSTRAINT "decision_rule_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_versions" ADD CONSTRAINT "decision_rule_version_parent_fk" FOREIGN KEY ("organization_id","decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rule_versions" ADD CONSTRAINT "decision_rule_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_rule_formula_variable_order" ON "decision_rule_formula_variables" USING btree ("organization_id","decision_rule_id","display_order");--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rule_parent_fk" FOREIGN KEY ("organization_id","parent_decision_rule_id") REFERENCES "public"."decision_rules"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_rule_active_scope_key" ON "decision_rules" USING btree ("organization_id","product_id","test_parameter_id","method_id") WHERE "decision_rules"."active";--> statement-breakpoint
ALTER TABLE "decision_rules" DROP COLUMN "sample_category_id";--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rule_test_group_fields" CHECK (("decision_rules"."is_test_group_parent" and "decision_rules"."test_group_name" is not null and length(trim("decision_rules"."test_group_name")) between 1 and 200
      and "decision_rules"."test_group_uid" is not null and "decision_rules"."test_group_uid" ~ '^[A-Za-z0-9_]+$' and length("decision_rules"."test_group_uid") between 1 and 100 and "decision_rules"."parent_decision_rule_id" is null)
    or (not "decision_rules"."is_test_group_parent" and "decision_rules"."test_group_name" is null and "decision_rules"."test_group_uid" is null));--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rule_formula_fields" CHECK ((not "decision_rules"."has_formula" or ("decision_rules"."formula" is not null and length("decision_rules"."formula") between 1 and 5000))
    and (not "decision_rules"."has_derived_formula" or ("decision_rules"."custom_formula" is not null and length("decision_rules"."custom_formula") between 1 and 5000))
    and ("decision_rules"."formula_text" is null or length("decision_rules"."formula_text") <= 5000) and ("decision_rules"."formula_expression" is null or length("decision_rules"."formula_expression") <= 5000));--> statement-breakpoint
ALTER TABLE "decision_rules" ADD CONSTRAINT "decision_rules_metadata" CHECK (length(trim("decision_rules"."code")) between 1 and 64 and ("decision_rules"."name" is null or length(trim("decision_rules"."name")) between 1 and 250) and "decision_rules"."revision" > 0);--> statement-breakpoint

ALTER TABLE decision_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_rule_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_rule_version_read ON decision_rule_versions FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
GRANT SELECT ON decision_rule_versions TO sampleify_app;
--> statement-breakpoint

CREATE FUNCTION masters_guard_decision_rule_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Decision Rule history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
    OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
    RAISE EXCEPTION 'Decision Rule history requires the actual editor and transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_rule_history_guard BEFORE INSERT OR UPDATE OR DELETE ON decision_rule_versions
  FOR EACH ROW EXECUTE FUNCTION masters_guard_decision_rule_history();

CREATE FUNCTION masters_track_decision_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Decision Rule writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New Decision Rules start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Decision Rule writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND (NEW.code,NEW.name,NEW.product_id,NEW.test_parameter_id,NEW.method_id,NEW.cutoff_value)
      IS DISTINCT FROM (OLD.code,OLD.name,OLD.product_id,OLD.test_parameter_id,OLD.method_id,OLD.cutoff_value) THEN
      RAISE EXCEPTION 'Decision Rule retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.decision_rule_versions(organization_id,decision_rule_id,revision,request_id,previous_revision,operation,
    code,name,parent_decision_rule_id,is_test_group_parent,test_group_name,test_group_uid,product_id,test_parameter_id,method_id,template_id,
    cutoff_value,greater_than_text,less_than_text,minimum_text,maximum_text,unit_of_measure,is_nabl,minimum_size,
    estimated_time_in_days,estimated_charges,express_time_in_days,express_charges,result_representation,default_narration,
    detectable_upper_limit,detectable_lower_limit,detectable_upper_limit_text,detectable_lower_limit_text,
    show_detectable_limit_text,show_standard_limit_text,conformance_limit,discipline,rule_group,unique_key,
    has_formula,formula,formula_text,has_derived_formula,custom_formula,formula_expression,active,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.parent_decision_rule_id,NEW.is_test_group_parent,NEW.test_group_name,NEW.test_group_uid,NEW.product_id,NEW.test_parameter_id,NEW.method_id,NEW.template_id,
    NEW.cutoff_value,NEW.greater_than_text,NEW.less_than_text,NEW.minimum_text,NEW.maximum_text,NEW.unit_of_measure,NEW.is_nabl,NEW.minimum_size,
    NEW.estimated_time_in_days,NEW.estimated_charges,NEW.express_time_in_days,NEW.express_charges,NEW.result_representation,NEW.default_narration,
    NEW.detectable_upper_limit,NEW.detectable_lower_limit,NEW.detectable_upper_limit_text,NEW.detectable_lower_limit_text,
    NEW.show_detectable_limit_text,NEW.show_standard_limit_text,NEW.conformance_limit,NEW.discipline,NEW.rule_group,NEW.unique_key,
    NEW.has_formula,NEW.formula,NEW.formula_text,NEW.has_derived_formula,NEW.custom_formula,NEW.formula_expression,NEW.active,actor);
  RETURN NEW;
END $$;
CREATE TRIGGER master_decision_rule_version AFTER INSERT OR UPDATE ON decision_rules FOR EACH ROW EXECUTE FUNCTION masters_track_decision_rule();
REVOKE ALL ON FUNCTION masters_guard_decision_rule_history(),masters_track_decision_rule() FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint

DO $$ DECLARE relation text; BEGIN
  -- decision_rule_limits already has its own RLS/grants/guard trigger from 0013; left untouched.
  FOREACH relation IN ARRAY ARRAY['decision_rule_sample_categories','decision_rule_instruments','decision_rule_formula_variables'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY decision_rule_child_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('CREATE POLICY decision_rule_child_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
