CREATE TABLE "parameter_version_custom_field_values" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"field_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"raw_kind" text NOT NULL,
	"raw_text" text,
	"raw_number" double precision,
	"raw_boolean" boolean,
	"raw_number_text" text,
	"interpretation_state" text NOT NULL,
	"parsed_number" double precision,
	"parsed_boolean" boolean,
	"parsed_date" date,
	"parsed_timestamp" timestamp with time zone,
	"option_id" uuid,
	"option_revision" integer,
	"user_id" uuid,
	"attachment_id" uuid,
	CONSTRAINT "parameter_custom_value_pk" PRIMARY KEY("organization_id","parameter_id","revision","field_id","position"),
	CONSTRAINT "parameter_custom_value_raw" CHECK ("parameter_version_custom_field_values"."position" between 0 and 499 and num_nonnulls("parameter_version_custom_field_values"."raw_text","parameter_version_custom_field_values"."raw_number","parameter_version_custom_field_values"."raw_boolean")=1
    and (("parameter_version_custom_field_values"."raw_kind"='text' and "parameter_version_custom_field_values"."raw_text" is not null and length("parameter_version_custom_field_values"."raw_text")<=16000)
      or ("parameter_version_custom_field_values"."raw_kind"='number' and "parameter_version_custom_field_values"."raw_number" is not null and "parameter_version_custom_field_values"."raw_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("parameter_version_custom_field_values"."raw_kind"='boolean' and "parameter_version_custom_field_values"."raw_boolean" is not null))),
	CONSTRAINT "parameter_custom_value_number_text" CHECK (case when "parameter_version_custom_field_values"."raw_kind"='number' then
    "parameter_version_custom_field_values"."raw_number_text" is not null and length("parameter_version_custom_field_values"."raw_number_text") between 1 and 32
    and case when "parameter_version_custom_field_values"."raw_number_text" ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then "parameter_version_custom_field_values"."raw_number_text"::double precision="parameter_version_custom_field_values"."raw_number" else false end
    else "parameter_version_custom_field_values"."raw_number_text" is null end),
	CONSTRAINT "parameter_custom_value_interpretation" CHECK ("parameter_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("parameter_version_custom_field_values"."parsed_number" is null or "parameter_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("parameter_version_custom_field_values"."parsed_timestamp" is null or isfinite("parameter_version_custom_field_values"."parsed_timestamp")) and ("parameter_version_custom_field_values"."parsed_date" is null or isfinite("parameter_version_custom_field_values"."parsed_date"))
    and (("parameter_version_custom_field_values"."option_id" is null and "parameter_version_custom_field_values"."option_revision" is null) or ("parameter_version_custom_field_values"."option_id" is not null and "parameter_version_custom_field_values"."option_revision" is not null and "parameter_version_custom_field_values"."option_revision">0))
    and ("parameter_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("parameter_version_custom_field_values"."parsed_number","parameter_version_custom_field_values"."parsed_boolean","parameter_version_custom_field_values"."parsed_date","parameter_version_custom_field_values"."parsed_timestamp","parameter_version_custom_field_values"."option_id","parameter_version_custom_field_values"."option_revision","parameter_version_custom_field_values"."user_id","parameter_version_custom_field_values"."attachment_id")=0)
    and (("parameter_version_custom_field_values"."interpretation_state"='empty')=("parameter_version_custom_field_values"."raw_kind"='text' and "parameter_version_custom_field_values"."raw_text"='')))
);
--> statement-breakpoint
CREATE TABLE "parameter_version_custom_fields" (
	"organization_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"field_id" uuid NOT NULL,
	"field_revision" integer NOT NULL,
	"field_type" text NOT NULL,
	"position" integer NOT NULL,
	"is_array" boolean NOT NULL,
	"value_count" integer NOT NULL,
	"display_kind" text NOT NULL,
	"display_text" text,
	"display_number" double precision,
	"display_boolean" boolean,
	"time_zone" text,
	"time_zone_data_version" text,
	"date_parser_version" text,
	CONSTRAINT "parameter_custom_field_pk" PRIMARY KEY("organization_id","parameter_id","revision","field_id"),
	CONSTRAINT "parameter_custom_field_position" UNIQUE("organization_id","parameter_id","revision","position"),
	CONSTRAINT "parameter_custom_field_shape" CHECK ("parameter_version_custom_fields"."position" between 0 and 499 and "parameter_version_custom_fields"."value_count" between 0 and 500
    and ("parameter_version_custom_fields"."is_array" or "parameter_version_custom_fields"."value_count"=1)
    and "parameter_version_custom_fields"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')),
	CONSTRAINT "parameter_custom_field_display" CHECK (num_nonnulls("parameter_version_custom_fields"."display_text","parameter_version_custom_fields"."display_number","parameter_version_custom_fields"."display_boolean")=1
    and (("parameter_version_custom_fields"."display_kind"='text' and "parameter_version_custom_fields"."display_text" is not null and length("parameter_version_custom_fields"."display_text")<=8000998)
      or ("parameter_version_custom_fields"."display_kind"='number' and "parameter_version_custom_fields"."display_number" is not null and "parameter_version_custom_fields"."display_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("parameter_version_custom_fields"."display_kind"='boolean' and "parameter_version_custom_fields"."display_boolean" is not null))
    and (not "parameter_version_custom_fields"."is_array" or "parameter_version_custom_fields"."display_kind"='text')),
	CONSTRAINT "parameter_custom_field_zone" CHECK (("parameter_version_custom_fields"."field_type" in ('date','date_time') and "parameter_version_custom_fields"."time_zone" is not null
      and length("parameter_version_custom_fields"."time_zone") between 1 and 100 and "parameter_version_custom_fields"."time_zone_data_version" is not null and length("parameter_version_custom_fields"."time_zone_data_version") between 1 and 40
      and "parameter_version_custom_fields"."date_parser_version" is not null and length("parameter_version_custom_fields"."date_parser_version") between 1 and 80)
    or ("parameter_version_custom_fields"."field_type" not in ('date','date_time') and num_nonnulls("parameter_version_custom_fields"."time_zone","parameter_version_custom_fields"."time_zone_data_version","parameter_version_custom_fields"."date_parser_version")=0))
);
--> statement-breakpoint
ALTER TABLE "test_parameters" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "test_parameters" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_version_custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_field_fk" FOREIGN KEY ("organization_id","parameter_id","revision","field_id") REFERENCES "public"."parameter_version_custom_fields"("organization_id","parameter_id","revision","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_option_fk" FOREIGN KEY ("organization_id","field_id","option_revision","option_id") REFERENCES "public"."custom_field_version_options"("organization_id","field_id","revision","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."custom_field_attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_fields" ADD CONSTRAINT "parameter_version_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_fields" ADD CONSTRAINT "parameter_custom_field_parameter_fk" FOREIGN KEY ("organization_id","parameter_id","revision") REFERENCES "public"."test_parameter_versions"("organization_id","parameter_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_fields" ADD CONSTRAINT "parameter_custom_field_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parameter_custom_value_raw_search" ON "parameter_version_custom_field_values" USING btree ("organization_id","field_id",md5("raw_text"),"parameter_id","revision") WHERE "parameter_version_custom_field_values"."raw_text" is not null;--> statement-breakpoint
CREATE INDEX "parameter_custom_field_definition" ON "parameter_version_custom_fields" USING btree ("organization_id","field_id","parameter_id","revision");--> statement-breakpoint
ALTER TABLE "test_parameters" ADD CONSTRAINT "parameter_custom_field_count" CHECK ("test_parameters"."custom_field_count" between 0 and 500);--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "parameter_version_custom_fields" CHECK ("test_parameter_versions"."custom_field_count" between 0 and 500 and ("test_parameter_versions"."operation"<>'retire' or not "test_parameter_versions"."custom_fields_provided"));
--> statement-breakpoint
-- Parameter fields use concrete version relationships and the same GenericForm value rules as Product.
CREATE FUNCTION masters_assert_parameter_custom_fields(target_organization uuid,target_parameter uuid,target_revision integer,check_definition_set boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions; field_count integer; minimum_position integer; maximum_position integer; item_count integer;
BEGIN
  SELECT * INTO version FROM public.test_parameter_versions
    WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parameter Custom Field history is missing' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_complete'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(value_count),0) INTO field_count,minimum_position,maximum_position,item_count
    FROM public.parameter_version_custom_fields
    WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision;
  IF field_count<>version.custom_field_count OR item_count>5000
    OR (field_count>0 AND (minimum_position<>0 OR maximum_position<>field_count-1)) THEN
    RAISE EXCEPTION 'Parameter Custom Fields require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_complete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.parameter_version_custom_fields field LEFT JOIN LATERAL (
      SELECT count(*) AS count,min(position) AS minimum,max(position) AS maximum
      FROM public.parameter_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.parameter_id=field.parameter_id
        AND value.revision=field.revision AND value.field_id=field.field_id
    ) items ON true
    WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision
      AND (items.count<>field.value_count OR (items.count>0 AND (items.minimum<>0 OR items.maximum<>items.count-1)))
  ) THEN RAISE EXCEPTION 'Parameter Custom Field items require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_complete'; END IF;
  IF version.custom_fields_provided THEN
    IF check_definition_set AND (EXISTS (
      SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='parameter'
      EXCEPT SELECT field_id,field_revision FROM public.parameter_version_custom_fields
        WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision
    ) OR EXISTS (
      SELECT field_id,field_revision FROM public.parameter_version_custom_fields
        WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision
      EXCEPT SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='parameter'
    )) THEN RAISE EXCEPTION 'Parameter Custom Field definitions changed' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_definition_set'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.parameter_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision AND definition.is_required
      AND NOT (
        (field.is_array AND definition.field_type<>'multi_user_select'
          AND (NOT definition.allows_multiple OR definition.field_type='attachment'))
        OR EXISTS (
        SELECT 1 FROM public.parameter_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.parameter_id=field.parameter_id AND value.revision=field.revision AND value.field_id=field.field_id
          AND CASE
            WHEN definition.field_type='multi_user_select'
              OR (definition.allows_multiple AND definition.field_type IN ('select','lookup')) THEN field.is_array
            WHEN definition.allows_multiple AND definition.field_type<>'attachment' AND NOT field.is_array THEN false
            WHEN NOT field.is_array THEN value.raw_kind<>'text' OR value.raw_text<>''
            WHEN value.raw_kind='boolean' THEN value.raw_boolean
            WHEN value.raw_kind='number' THEN true
            ELSE public.masters_custom_field_trim(value.raw_text)<>''
          END
        )
      )
    ) THEN RAISE EXCEPTION 'A required Parameter Custom Field is empty' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_required'; END IF;
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION masters_assert_parameter_custom_field_uniqueness(target_organization uuid,target_parameter uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.parameter_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.parameter_version_custom_field_values value ON value.organization_id=field.organization_id AND value.parameter_id=field.parameter_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.parameter_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.parameter_version_custom_field_values value ON value.organization_id=field.organization_id AND value.parameter_id=field.parameter_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.parameter_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.test_parameters parameter ON parameter.organization_id=existing.organization_id AND parameter.id=existing.parameter_id AND parameter.revision=existing.revision AND parameter.active
    WHERE field.organization_id=target_organization AND field.parameter_id=target_parameter AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.parameter_id<>target_parameter
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_parameter_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer; unique_field uuid;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||NEW.organization_id::text,0));
  FOR unique_field IN SELECT id FROM public.custom_field_definitions
    WHERE organization_id=NEW.organization_id AND associated_with='parameter' AND active AND validate_uniqueness ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('parameter-custom-field-unique:'||NEW.organization_id::text||':'||unique_field::text,0));
  END LOOP;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.test_parameter_versions WHERE organization_id=OLD.organization_id AND parameter_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_parameter_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF NOT NEW.active AND NEW.custom_fields_provided THEN
    RAISE EXCEPTION 'Parameter retirement preserves Custom Fields' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_preserve';
  END IF;
  IF NEW.custom_fields_provided THEN
    SELECT count(*) INTO expected_count FROM public.custom_field_definitions
      WHERE organization_id=NEW.organization_id AND associated_with='parameter' AND active;
    IF expected_count<>NEW.custom_field_count THEN
      RAISE EXCEPTION 'Provide the current Parameter Custom Fields' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_definition_set';
    END IF;
  ELSE
    expected_count := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.custom_field_count END;
    IF NEW.custom_field_count<>expected_count OR (NEW.active AND EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND associated_with='parameter' AND active
    )) THEN RAISE EXCEPTION 'Parameter Custom Field omission requires no current definitions' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_preserve'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER master_parameter_custom_field_change BEFORE INSERT OR UPDATE ON test_parameters
  FOR EACH ROW EXECUTE FUNCTION masters_guard_parameter_custom_field_change();
--> statement-breakpoint
CREATE FUNCTION masters_initialize_parameter_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE parameter public.test_parameters;
BEGIN
  SELECT * INTO parameter FROM public.test_parameters WHERE organization_id=NEW.organization_id AND id=NEW.parameter_id AND revision=NEW.revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parameter field history requires its actual Parameter revision' USING ERRCODE='23514'; END IF;
  NEW.custom_field_count := parameter.custom_field_count;
  NEW.custom_fields_provided := parameter.custom_fields_provided;
  RETURN NEW;
END $$;
CREATE TRIGGER parameter_custom_field_metadata BEFORE INSERT ON test_parameter_versions
  FOR EACH ROW EXECUTE FUNCTION masters_initialize_parameter_custom_field_metadata();
--> statement-breakpoint
CREATE FUNCTION masters_guard_parameter_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions; field public.parameter_version_custom_fields; definition public.custom_field_versions;
  related_count integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Parameter Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.test_parameter_versions WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision;
  IF version.parameter_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.test_parameters WHERE organization_id=NEW.organization_id AND id=NEW.parameter_id
        AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
    RAISE EXCEPTION 'Parameter Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='parameter_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Parameter Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Parameter Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='parameter' AND active
    ) THEN RAISE EXCEPTION 'Select the current Parameter Custom Field revision' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.parameter_version_custom_fields
      WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Parameter Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Parameter Custom Field items' USING ERRCODE='23514';
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id);
    IF NEW.interpretation_state='valid' THEN
      CASE field.field_type
        WHEN 'number' THEN
          IF NEW.parsed_number IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A numeric field requires its typed numeric interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'checkbox' THEN
          IF NEW.parsed_boolean IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A checkbox requires its typed boolean interpretation' USING ERRCODE='23514'; END IF;
        WHEN 'date' THEN
          IF NEW.parsed_date IS NULL OR NEW.parsed_timestamp IS NULL OR related_count<>2 THEN RAISE EXCEPTION 'A date requires its local date and parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'date_time' THEN
          IF NEW.parsed_timestamp IS NULL OR related_count<>1 THEN RAISE EXCEPTION 'A date-time field requires its parsed instant' USING ERRCODE='23514'; END IF;
        WHEN 'select' THEN
          IF NEW.option_id IS NULL OR NEW.option_revision IS NULL OR related_count<>2 OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
              AND option.field_id=NEW.field_id AND option.revision=NEW.option_revision AND option.id=NEW.option_id
              AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.parameter_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id AND previous.revision=version.previous_revision
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Parameter revision' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id AND attachment.field_id=NEW.field_id
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN RAISE EXCEPTION 'This lookup has no configured source' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_lookup';
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['parameter_version_custom_fields','parameter_version_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY parameter_custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('CREATE POLICY parameter_custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_report_worker',relation);
    EXECUTE format('CREATE TRIGGER parameter_custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_parameter_custom_field_history()',relation);
  END LOOP;
END $$;

--> statement-breakpoint

CREATE FUNCTION masters_assert_parameter_custom_field_preservation(target_organization uuid,target_parameter uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions;
BEGIN
  SELECT * INTO version FROM public.test_parameter_versions WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision EXCEPT SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision EXCEPT SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision) OR EXISTS (SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision EXCEPT SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision EXCEPT SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision) THEN
    RAISE EXCEPTION 'Parameter Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_preserve_parameter_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.parameter_version_custom_fields("organization_id","parameter_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","parameter_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields
    WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision;
  INSERT INTO public.parameter_version_custom_field_values("organization_id","parameter_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id")
    SELECT "organization_id","parameter_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id" FROM public.parameter_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
CREATE TRIGGER parameter_custom_fields_preserve AFTER INSERT ON test_parameter_versions FOR EACH ROW EXECUTE FUNCTION masters_preserve_parameter_custom_fields();
--> statement-breakpoint
CREATE FUNCTION masters_check_parameter_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_parameter_custom_fields(NEW.organization_id,NEW.parameter_id,NEW.revision,true);
  PERFORM public.masters_assert_parameter_custom_field_preservation(NEW.organization_id,NEW.parameter_id,NEW.revision);
  IF NEW.custom_fields_provided THEN PERFORM public.masters_assert_parameter_custom_field_uniqueness(NEW.organization_id,NEW.parameter_id,NEW.revision); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER parameter_custom_fields_complete AFTER INSERT ON test_parameter_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_parameter_custom_fields();
--> statement-breakpoint
REVOKE ALL ON FUNCTION masters_assert_parameter_custom_fields(uuid,uuid,integer,boolean),
  masters_assert_parameter_custom_field_uniqueness(uuid,uuid,integer),masters_guard_parameter_custom_field_change(),
  masters_initialize_parameter_custom_field_metadata(),masters_guard_parameter_custom_field_history(),
  masters_assert_parameter_custom_field_preservation(uuid,uuid,integer),masters_preserve_parameter_custom_fields(),masters_check_parameter_custom_fields()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;

--> statement-breakpoint
ALTER POLICY custom_field_attachment_read ON custom_field_attachments USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage'))
  AND EXISTS (SELECT 1 FROM custom_field_versions definition
    WHERE definition.organization_id=custom_field_attachments.organization_id AND definition.field_id=custom_field_attachments.field_id
      AND definition.revision=custom_field_attachments.field_revision AND definition.associated_with IN ('product','parameter') AND definition.field_type='attachment')
);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION custom_field_guard_attachment() RETURNS trigger
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
  IF definition.id IS NULL OR NOT definition.active OR definition.field_type<>'attachment' OR definition.associated_with NOT IN ('product','parameter')
    OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires the current active Product or Parameter field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  RETURN NEW;
END $$;
