CREATE TABLE "instrument_version_custom_field_values" (
	"organization_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
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
	"lookup_source_id" uuid,
	"lookup_revision" integer,
	"lookup_line_id" text,
	CONSTRAINT "instrument_custom_value_pk" PRIMARY KEY("organization_id","instrument_id","revision","field_id","position"),
	CONSTRAINT "instrument_custom_value_lookup_reference" CHECK (num_nonnulls("instrument_version_custom_field_values"."lookup_source_id","instrument_version_custom_field_values"."lookup_revision","instrument_version_custom_field_values"."lookup_line_id")=0
    or ("instrument_version_custom_field_values"."lookup_source_id" is not null and "instrument_version_custom_field_values"."lookup_revision" is not null and "instrument_version_custom_field_values"."lookup_revision">0 and "instrument_version_custom_field_values"."lookup_line_id" is not null)),
	CONSTRAINT "instrument_custom_value_raw" CHECK ("instrument_version_custom_field_values"."position" between 0 and 499 and num_nonnulls("instrument_version_custom_field_values"."raw_text","instrument_version_custom_field_values"."raw_number","instrument_version_custom_field_values"."raw_boolean")=1
    and (("instrument_version_custom_field_values"."raw_kind"='text' and "instrument_version_custom_field_values"."raw_text" is not null and length("instrument_version_custom_field_values"."raw_text")<=16000)
      or ("instrument_version_custom_field_values"."raw_kind"='number' and "instrument_version_custom_field_values"."raw_number" is not null and "instrument_version_custom_field_values"."raw_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("instrument_version_custom_field_values"."raw_kind"='boolean' and "instrument_version_custom_field_values"."raw_boolean" is not null))),
	CONSTRAINT "instrument_custom_value_number_text" CHECK (case when "instrument_version_custom_field_values"."raw_kind"='number' then
    "instrument_version_custom_field_values"."raw_number_text" is not null and length("instrument_version_custom_field_values"."raw_number_text") between 1 and 32
    and case when "instrument_version_custom_field_values"."raw_number_text" ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then "instrument_version_custom_field_values"."raw_number_text"::double precision="instrument_version_custom_field_values"."raw_number" else false end
    else "instrument_version_custom_field_values"."raw_number_text" is null end),
	CONSTRAINT "instrument_custom_value_interpretation" CHECK ("instrument_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("instrument_version_custom_field_values"."parsed_number" is null or "instrument_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("instrument_version_custom_field_values"."parsed_timestamp" is null or isfinite("instrument_version_custom_field_values"."parsed_timestamp")) and ("instrument_version_custom_field_values"."parsed_date" is null or isfinite("instrument_version_custom_field_values"."parsed_date"))
    and (("instrument_version_custom_field_values"."option_id" is null and "instrument_version_custom_field_values"."option_revision" is null) or ("instrument_version_custom_field_values"."option_id" is not null and "instrument_version_custom_field_values"."option_revision" is not null and "instrument_version_custom_field_values"."option_revision">0))
    and ("instrument_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("instrument_version_custom_field_values"."parsed_number","instrument_version_custom_field_values"."parsed_boolean","instrument_version_custom_field_values"."parsed_date","instrument_version_custom_field_values"."parsed_timestamp","instrument_version_custom_field_values"."option_id","instrument_version_custom_field_values"."option_revision","instrument_version_custom_field_values"."user_id","instrument_version_custom_field_values"."attachment_id","instrument_version_custom_field_values"."lookup_source_id","instrument_version_custom_field_values"."lookup_revision","instrument_version_custom_field_values"."lookup_line_id")=0)
    and (("instrument_version_custom_field_values"."interpretation_state"='empty')=("instrument_version_custom_field_values"."raw_kind"='text' and "instrument_version_custom_field_values"."raw_text"='')))
);

--> statement-breakpoint
CREATE TABLE "instrument_version_custom_fields" (
	"organization_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
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
	CONSTRAINT "instrument_custom_field_pk" PRIMARY KEY("organization_id","instrument_id","revision","field_id"),
	CONSTRAINT "instrument_custom_field_position" UNIQUE("organization_id","instrument_id","revision","position"),
	CONSTRAINT "instrument_custom_field_shape" CHECK ("instrument_version_custom_fields"."position" between 0 and 499 and "instrument_version_custom_fields"."value_count" between 0 and 500
    and ("instrument_version_custom_fields"."is_array" or "instrument_version_custom_fields"."value_count"=1)
    and "instrument_version_custom_fields"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')),
	CONSTRAINT "instrument_custom_field_display" CHECK (num_nonnulls("instrument_version_custom_fields"."display_text","instrument_version_custom_fields"."display_number","instrument_version_custom_fields"."display_boolean")=1
    and (("instrument_version_custom_fields"."display_kind"='text' and "instrument_version_custom_fields"."display_text" is not null and length("instrument_version_custom_fields"."display_text")<=8000998)
      or ("instrument_version_custom_fields"."display_kind"='number' and "instrument_version_custom_fields"."display_number" is not null and "instrument_version_custom_fields"."display_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("instrument_version_custom_fields"."display_kind"='boolean' and "instrument_version_custom_fields"."display_boolean" is not null))
    and (not "instrument_version_custom_fields"."is_array" or "instrument_version_custom_fields"."display_kind"='text')),
	CONSTRAINT "instrument_custom_field_zone" CHECK (("instrument_version_custom_fields"."field_type" in ('date','date_time') and "instrument_version_custom_fields"."time_zone" is not null
      and length("instrument_version_custom_fields"."time_zone") between 1 and 100 and "instrument_version_custom_fields"."time_zone_data_version" is not null and length("instrument_version_custom_fields"."time_zone_data_version") between 1 and 40
      and "instrument_version_custom_fields"."date_parser_version" is not null and length("instrument_version_custom_fields"."date_parser_version") between 1 and 80)
    or ("instrument_version_custom_fields"."field_type" not in ('date','date_time') and num_nonnulls("instrument_version_custom_fields"."time_zone","instrument_version_custom_fields"."time_zone_data_version","instrument_version_custom_fields"."date_parser_version")=0))
);

--> statement-breakpoint
ALTER TABLE "instrument_versions" DROP CONSTRAINT "instrument_version_values";
--> statement-breakpoint
ALTER TABLE "instruments" DROP CONSTRAINT "instrument_values";
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_field_values" ADD CONSTRAINT "instrument_version_custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_field_values" ADD CONSTRAINT "instrument_custom_value_field_fk" FOREIGN KEY ("organization_id","instrument_id","revision","field_id") REFERENCES "public"."instrument_version_custom_fields"("organization_id","instrument_id","revision","field_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_field_values" ADD CONSTRAINT "instrument_custom_value_option_fk" FOREIGN KEY ("organization_id","field_id","option_revision","option_id") REFERENCES "public"."custom_field_version_options"("organization_id","field_id","revision","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_field_values" ADD CONSTRAINT "instrument_custom_value_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_field_values" ADD CONSTRAINT "instrument_custom_value_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."custom_field_attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_field_values" ADD CONSTRAINT "instrument_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_fields" ADD CONSTRAINT "instrument_version_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_fields" ADD CONSTRAINT "instrument_custom_field_instrument_fk" FOREIGN KEY ("organization_id","instrument_id","revision") REFERENCES "public"."instrument_versions"("organization_id","instrument_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instrument_version_custom_fields" ADD CONSTRAINT "instrument_custom_field_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "instrument_custom_value_raw_search" ON "instrument_version_custom_field_values" USING btree ("organization_id","field_id",md5("raw_text"),"instrument_id","revision") WHERE "instrument_version_custom_field_values"."raw_text" is not null;
--> statement-breakpoint
CREATE INDEX "instrument_custom_field_definition" ON "instrument_version_custom_fields" USING btree ("organization_id","field_id","instrument_id","revision");
--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_version_values" CHECK (length(trim("instrument_versions"."code")) between 1 and 64 and "instrument_versions"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim("instrument_versions"."name")) between 1 and 200 and ("instrument_versions"."description" is null or length("instrument_versions"."description")<=5000)
  and ("instrument_versions"."make" is null or length("instrument_versions"."make")<=200) and ("instrument_versions"."model_name" is null or length("instrument_versions"."model_name")<=200)
  and ("instrument_versions"."serial_number" is null or length("instrument_versions"."serial_number")<=200) and ("instrument_versions"."calibration_agency" is null or length("instrument_versions"."calibration_agency")<=250)
  and ("instrument_versions"."current_location" is null or length("instrument_versions"."current_location")<=250) and ("instrument_versions"."manufacturer_supplier" is null or length("instrument_versions"."manufacturer_supplier")<=250)
  and ("instrument_versions"."date_of_installation" is null or "instrument_versions"."date_of_installation" between date '0001-01-01' and date '9999-12-31')
  and ("instrument_versions"."cost_of_equipment" is null or ("instrument_versions"."cost_of_equipment">=0 and "instrument_versions"."cost_of_equipment" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)))
  and "instrument_versions"."status" in ('available','in_use','maintenance','out_of_service','retired') and "instrument_versions"."current_status" in ('is_working','in_breakdown')
  and (not "instrument_versions"."retired" or not "instrument_versions"."active") and ("instrument_versions"."active" or "instrument_versions"."status"='retired')
  and "instrument_versions"."custom_field_count" between 0 and 500 and (not "instrument_versions"."retired" or not "instrument_versions"."custom_fields_provided"));
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instrument_values" CHECK (length(trim("instruments"."code")) between 1 and 64 and "instruments"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  and length(trim("instruments"."name")) between 1 and 200 and ("instruments"."description" is null or length("instruments"."description")<=5000)
  and ("instruments"."make" is null or length("instruments"."make")<=200) and ("instruments"."model_name" is null or length("instruments"."model_name")<=200)
  and ("instruments"."serial_number" is null or length("instruments"."serial_number")<=200) and ("instruments"."calibration_agency" is null or length("instruments"."calibration_agency")<=250)
  and ("instruments"."current_location" is null or length("instruments"."current_location")<=250) and ("instruments"."manufacturer_supplier" is null or length("instruments"."manufacturer_supplier")<=250)
  and ("instruments"."date_of_installation" is null or "instruments"."date_of_installation" between date '0001-01-01' and date '9999-12-31')
  and ("instruments"."cost_of_equipment" is null or ("instruments"."cost_of_equipment">=0 and "instruments"."cost_of_equipment" not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)))
  and "instruments"."status" in ('available','in_use','maintenance','out_of_service','retired') and "instruments"."current_status" in ('is_working','in_breakdown')
  and (not "instruments"."retired" or not "instruments"."active") and ("instruments"."active" or "instruments"."status"='retired')
  and "instruments"."custom_field_count" between 0 and 500 and (not "instruments"."retired" or not "instruments"."custom_fields_provided"));

--> statement-breakpoint
CREATE FUNCTION masters_assert_instrument_custom_fields(target_organization uuid,target_instrument uuid,target_revision integer,check_definition_set boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.instrument_versions; field_count integer; minimum_position integer; maximum_position integer; item_count integer;
BEGIN
  SELECT * INTO version FROM public.instrument_versions
    WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instrument Custom Field history is missing' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_complete'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(value_count),0) INTO field_count,minimum_position,maximum_position,item_count
    FROM public.instrument_version_custom_fields
    WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision;
  IF field_count<>version.custom_field_count OR item_count>5000
    OR (field_count>0 AND (minimum_position<>0 OR maximum_position<>field_count-1)) THEN
    RAISE EXCEPTION 'Instrument Custom Fields require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_complete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.instrument_version_custom_fields field LEFT JOIN LATERAL (
      SELECT count(*) AS count,min(position) AS minimum,max(position) AS maximum
      FROM public.instrument_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.instrument_id=field.instrument_id
        AND value.revision=field.revision AND value.field_id=field.field_id
    ) items ON true
    WHERE field.organization_id=target_organization AND field.instrument_id=target_instrument AND field.revision=target_revision
      AND (items.count<>field.value_count OR (items.count>0 AND (items.minimum<>0 OR items.maximum<>items.count-1)))
  ) THEN RAISE EXCEPTION 'Instrument Custom Field items require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_complete'; END IF;
  IF version.custom_fields_provided THEN
    IF check_definition_set AND (EXISTS (
      SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='instrument'
      EXCEPT SELECT field_id,field_revision FROM public.instrument_version_custom_fields
        WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision
    ) OR EXISTS (
      SELECT field_id,field_revision FROM public.instrument_version_custom_fields
        WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision
      EXCEPT SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='instrument'
    )) THEN RAISE EXCEPTION 'Instrument Custom Field definitions changed' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_definition_set'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.instrument_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      WHERE field.organization_id=target_organization AND field.instrument_id=target_instrument AND field.revision=target_revision AND definition.is_required
      AND NOT (
        (field.is_array AND definition.field_type<>'multi_user_select'
          AND (NOT definition.allows_multiple OR definition.field_type='attachment'))
        OR EXISTS (
        SELECT 1 FROM public.instrument_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.instrument_id=field.instrument_id AND value.revision=field.revision AND value.field_id=field.field_id
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
    ) THEN RAISE EXCEPTION 'A required Instrument Custom Field is empty' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_required'; END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_instrument_custom_field_uniqueness(target_organization uuid,target_instrument uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.instrument_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=target_organization AND field.instrument_id=target_instrument AND field.revision=target_revision
      AND definition.validate_uniqueness
  ) THEN RETURN; END IF;
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.instrument_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.instrument_version_custom_field_values value ON value.organization_id=field.organization_id AND value.instrument_id=field.instrument_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.instrument_id=target_instrument AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.instrument_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.instrument_version_custom_field_values value ON value.organization_id=field.organization_id AND value.instrument_id=field.instrument_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.instrument_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.instruments instrument ON instrument.organization_id=existing.organization_id AND instrument.id=existing.instrument_id AND instrument.revision=existing.revision AND NOT instrument.retired
    WHERE field.organization_id=target_organization AND field.instrument_id=target_instrument AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.instrument_id<>target_instrument
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_instrument_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer;
BEGIN
  PERFORM public.instruments_require_writer();
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() THEN
    RAISE EXCEPTION 'Instrument fields require the authenticated organization' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.instrument_versions WHERE organization_id=OLD.organization_id AND instrument_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_instrument_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF NEW.retired AND NEW.custom_fields_provided THEN
    RAISE EXCEPTION 'Instrument retirement preserves Custom Fields' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_preserve';
  END IF;
  IF NEW.custom_fields_provided THEN
    SELECT count(*) INTO expected_count FROM public.custom_field_definitions
      WHERE organization_id=NEW.organization_id AND associated_with='instrument' AND active;
    IF expected_count<>NEW.custom_field_count THEN
      RAISE EXCEPTION 'Provide the current Instrument Custom Fields' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_definition_set';
    END IF;
  ELSE
    expected_count := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.custom_field_count END;
    IF NEW.custom_field_count<>expected_count OR (NOT NEW.retired AND EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND associated_with='instrument' AND active
    )) THEN RAISE EXCEPTION 'Instrument Custom Field omission requires no current definitions' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_preserve'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instrument_custom_field_change BEFORE INSERT OR UPDATE ON instruments FOR EACH ROW EXECUTE FUNCTION masters_guard_instrument_custom_field_change();
--> statement-breakpoint
CREATE FUNCTION masters_initialize_instrument_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE instrument public.instruments;
BEGIN
  SELECT * INTO instrument FROM public.instruments WHERE organization_id=NEW.organization_id AND id=NEW.instrument_id AND revision=NEW.revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instrument field history requires its actual Instrument revision' USING ERRCODE='23514'; END IF;
  NEW.custom_field_count := instrument.custom_field_count;
  NEW.custom_fields_provided := instrument.custom_fields_provided;
  RETURN NEW;
END $$;
CREATE TRIGGER instrument_custom_field_metadata BEFORE INSERT ON instrument_versions FOR EACH ROW EXECUTE FUNCTION masters_initialize_instrument_custom_field_metadata();
--> statement-breakpoint
CREATE FUNCTION masters_guard_instrument_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.instrument_versions; field public.instrument_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Instrument Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.instrument_versions WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.revision;
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() OR version.instrument_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.instruments WHERE organization_id=NEW.organization_id AND id=NEW.instrument_id
        AND revision=NEW.revision AND save_request_id=version.request_id)) THEN
    RAISE EXCEPTION 'Instrument Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='instrument_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Instrument Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Instrument Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='instrument' AND active
    ) THEN RAISE EXCEPTION 'Select the current Instrument Custom Field revision' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.instrument_version_custom_fields
      WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Instrument Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Instrument Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.instrument_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.instrument_id=NEW.instrument_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
      END IF;
    ELSIF field.field_type='select' AND version.previous_revision>0 AND (
      NEW.interpretation_state='invalid' OR version.custom_fields_provided AND NEW.option_revision<>field.field_revision
    ) THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      -- Restrict prior items to the same saved key before checking their raw values.
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          SELECT field_id FROM public.instrument_version_custom_fields
            WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    ELSIF field.field_type='attachment' AND NEW.interpretation_state='valid' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF version.previous_revision>0 THEN
        WITH key_definitions AS MATERIALIZED (
          SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=definition.key
        ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
          FROM key_definitions previous_definition JOIN LATERAL (
            SELECT field_id FROM public.instrument_version_custom_fields
              WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=version.previous_revision
                AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
          ) previous_field ON true;
      END IF;
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id,NEW.lookup_source_id,NEW.lookup_revision,NEW.lookup_line_id);
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.instrument_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.instrument_id=NEW.instrument_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Instrument revision' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with='instrument' AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.instrument_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.instrument_id=NEW.instrument_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN
          IF NEW.lookup_source_id IS NULL OR NEW.lookup_revision IS NULL OR NEW.lookup_line_id IS NULL OR related_count<>3
            OR definition.lookup_source_id IS DISTINCT FROM NEW.lookup_source_id
            OR NEW.lookup_line_id IS DISTINCT FROM (CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END)
            OR NOT EXISTS (
              SELECT 1 FROM public.custom_field_lookup_lines line
              WHERE line.organization_id=NEW.organization_id AND line.source_id=NEW.lookup_source_id
                AND line.revision=NEW.lookup_revision AND line.original_line_id=NEW.lookup_line_id
                AND (NOT version.custom_fields_provided OR EXISTS (
                  SELECT 1 FROM public.custom_field_lookup_sources source
                    WHERE source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
                ))
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Keep an unavailable saved value without claiming a foreign definition's option.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.instrument_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.instrument_id=NEW.instrument_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.instrument_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.instrument_id=NEW.instrument_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='instrument_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['instrument_version_custom_fields','instrument_version_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY instrument_custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope())
        AND (SELECT instruments_can_read(NULL)) AND instruments_can_read(instrument_id))',relation);
    EXECUTE format('CREATE POLICY instrument_custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT instruments_require_writer() IS NOT NULL))',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_report_worker',relation);
    EXECUTE format('CREATE TRIGGER instrument_custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_instrument_custom_field_history()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_instrument_custom_field_preservation(target_organization uuid,target_instrument uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.instrument_versions;
BEGIN
  SELECT * INTO version FROM public.instrument_versions WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","instrument_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.instrument_version_custom_fields WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision EXCEPT SELECT "organization_id","instrument_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.instrument_version_custom_fields WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","instrument_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.instrument_version_custom_fields WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=version.previous_revision EXCEPT SELECT "organization_id","instrument_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.instrument_version_custom_fields WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision) OR EXISTS (SELECT "organization_id","instrument_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.instrument_version_custom_field_values WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision EXCEPT SELECT "organization_id","instrument_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.instrument_version_custom_field_values WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","instrument_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.instrument_version_custom_field_values WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=version.previous_revision EXCEPT SELECT "organization_id","instrument_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.instrument_version_custom_field_values WHERE organization_id=target_organization AND instrument_id=target_instrument AND revision=target_revision) THEN
    RAISE EXCEPTION 'Instrument Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='instrument_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_preserve_instrument_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.instrument_version_custom_fields("organization_id","instrument_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","instrument_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.instrument_version_custom_fields
    WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.previous_revision;
  INSERT INTO public.instrument_version_custom_field_values("organization_id","instrument_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id")
    SELECT "organization_id","instrument_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.instrument_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND instrument_id=NEW.instrument_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_check_instrument_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_instrument_custom_fields(NEW.organization_id,NEW.instrument_id,NEW.revision,true);
  PERFORM public.masters_assert_instrument_custom_field_preservation(NEW.organization_id,NEW.instrument_id,NEW.revision);
  IF NEW.custom_fields_provided THEN PERFORM public.masters_assert_instrument_custom_field_uniqueness(NEW.organization_id,NEW.instrument_id,NEW.revision); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER instrument_custom_fields_preserve AFTER INSERT ON instrument_versions FOR EACH ROW EXECUTE FUNCTION masters_preserve_instrument_custom_fields();
CREATE CONSTRAINT TRIGGER instrument_custom_fields_complete AFTER INSERT ON instrument_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_instrument_custom_fields();
REVOKE ALL ON FUNCTION masters_assert_instrument_custom_fields(uuid,uuid,integer,boolean),masters_guard_instrument_custom_field_change(),
  masters_initialize_instrument_custom_field_metadata(),masters_guard_instrument_custom_field_history(),masters_assert_instrument_custom_field_uniqueness(uuid,uuid,integer),
  masters_assert_instrument_custom_field_preservation(uuid,uuid,integer),masters_preserve_instrument_custom_fields(),masters_check_instrument_custom_fields()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint

--> statement-breakpoint
CREATE FUNCTION instruments_save(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text,
  p_code text,p_name text,p_description text,p_laboratory_id uuid,p_make text,p_model_name text,p_serial_number text,p_date_of_installation date,
  p_calibration_agency text,p_calibrated boolean,p_cost_of_equipment numeric,p_purchase_file_id uuid,p_current_location text,p_manufacturer_supplier text,p_active boolean,
  p_user_ids uuid[],p_services_provided boolean,p_service_ids uuid[],p_service_codes text[],p_template_ids uuid[],p_workflow_ids uuid[],
  p_reminder_before integer[],p_frequency integer[],p_last_performed date[],p_reminder_frequency integer[],p_next_reminder date[],p_service_active boolean[],
  p_role_service_ids uuid[],p_role_ids uuid[],p_custom_field_count integer,p_custom_fields_provided boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.instruments; old_version public.instrument_versions;
  next_revision integer:=expected_revision+1; definition_revision integer; service_count integer:=cardinality(p_service_ids); user_count integer;
BEGIN
  prior:=public.instruments_prior_request(target_id,expected_revision,requested_id,fingerprint,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO head FROM public.instruments WHERE organization_id=org AND id=target_id FOR UPDATE;
  IF expected_revision>0 AND (head.id IS NULL OR head.retired) THEN
    RAISE EXCEPTION 'Instrument was not found' USING ERRCODE='P0002',CONSTRAINT='instrument_not_found';
  END IF;
  IF coalesce(head.revision,0)<>expected_revision THEN
    RAISE EXCEPTION 'Instrument changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='instrument_stale_revision';
  END IF;
  SELECT * INTO old_version FROM public.instrument_versions WHERE organization_id=org AND instrument_id=target_id AND revision=expected_revision;
  IF p_custom_field_count IS NULL OR p_custom_field_count NOT BETWEEN 0 AND 500 OR p_custom_fields_provided IS NULL OR p_laboratory_id IS NULL OR p_date_of_installation IS NULL OR p_services_provided IS NULL
    OR (p_user_ids IS NULL AND expected_revision=0) OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids) NOT BETWEEN 1 AND 500 OR array_ndims(p_user_ids)<>1 OR array_position(p_user_ids,NULL) IS NOT NULL))
    OR service_count IS NULL OR service_count NOT BETWEEN 0 AND 100 OR (NOT p_services_provided AND service_count<>0)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[cardinality(p_service_codes),cardinality(p_template_ids),cardinality(p_workflow_ids),cardinality(p_reminder_before),cardinality(p_frequency),
      cardinality(p_last_performed),cardinality(p_reminder_frequency),cardinality(p_next_reminder),cardinality(p_service_active)]) size WHERE size IS DISTINCT FROM service_count)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[array_ndims(p_service_ids),array_ndims(p_service_codes),array_ndims(p_template_ids),array_ndims(p_workflow_ids),array_ndims(p_reminder_before),array_ndims(p_frequency),
      array_ndims(p_last_performed),array_ndims(p_reminder_frequency),array_ndims(p_next_reminder),array_ndims(p_service_active),array_ndims(p_role_ids),array_ndims(p_role_service_ids)]) dimensions WHERE dimensions>1)
    OR cardinality(p_role_ids) IS NULL OR cardinality(p_role_ids)>50000 OR cardinality(p_role_service_ids) IS DISTINCT FROM cardinality(p_role_ids)
    OR EXISTS (SELECT 1 FROM unnest(p_role_service_ids,p_role_ids) item(service_id,role_id) WHERE service_id IS NULL OR role_id IS NULL OR NOT service_id=ANY(p_service_ids))
    OR EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes,p_reminder_before,p_service_active) item(id,code,reminder,active) WHERE id IS NULL OR code IS NULL OR reminder IS NULL OR active IS NULL)
    OR (SELECT count(DISTINCT lower(code)) FROM unnest(p_service_codes) item(code))<>service_count THEN
    RAISE EXCEPTION 'Invalid Instrument fields or relationship arrays' USING ERRCODE='23514',CONSTRAINT='instrument_command_input';
  END IF;
  IF p_user_ids IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_user_ids) wanted(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=wanted.id)) THEN
    RAISE EXCEPTION 'Instrument users must belong to this organization' USING ERRCODE='23514',CONSTRAINT='instrument_reference';
  END IF;
  SELECT max(revision) INTO definition_revision FROM public.organization_instrument_service_versions WHERE organization_id=org;
  -- Template type changes lock their parent below; hold that parent until capture.
  PERFORM 1 FROM public.templates WHERE organization_id=org AND id=ANY(p_template_ids) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.workflows WHERE organization_id=org AND id=ANY(p_workflow_ids) ORDER BY id FOR SHARE;
  IF p_services_provided AND EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes,p_template_ids,p_workflow_ids) wanted(id,code,template_id,workflow_id)
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_instrument_service_entries definition WHERE definition.organization_id=org
      AND definition.revision=definition_revision AND definition.service_code=wanted.code AND definition.active)
    OR (wanted.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN LATERAL (
      SELECT kind FROM public.template_versions WHERE organization_id=org AND template_id=template.id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1
    ) version ON version.kind='equipment_service_log' WHERE template.organization_id=org AND template.id=wanted.template_id AND template.active))
    OR (wanted.workflow_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflows WHERE organization_id=org AND id=wanted.workflow_id AND active AND applies_to='instrument_service'))) THEN
    RAISE EXCEPTION 'Select configured active services and matching templates/workflows' USING ERRCODE='23514',CONSTRAINT='instrument_service_reference';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes) wanted(id,code)
    JOIN public.organization_instrument_service_entries definition ON definition.organization_id=org AND definition.revision=definition_revision AND definition.service_code=wanted.code
    JOIN public.instrument_version_services previous ON previous.organization_id=org AND previous.instrument_id=target_id AND previous.id=wanted.id
    WHERE previous.service_definition_id<>definition.id) THEN
    RAISE EXCEPTION 'A service configuration identity cannot be reused for another type' USING ERRCODE='23514',CONSTRAINT='instrument_service_identity';
  END IF;
  user_count:=CASE WHEN p_user_ids IS NULL THEN old_version.user_count ELSE cardinality(p_user_ids) END;
  IF NOT p_services_provided THEN service_count:=coalesce(old_version.service_count,0); END IF;
  -- Validate before numeric(18,2) rounds a small negative amount to zero.
  IF p_cost_of_equipment<0 OR p_cost_of_equipment IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) THEN
    RAISE EXCEPTION 'Instrument cost must be finite and nonnegative' USING ERRCODE='23514',CONSTRAINT='instrument_values';
  END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.instruments(organization_id,id,code,name,description,laboratory_id,make,model_name,serial_number,date_of_installation,calibration_agency,calibrated,
      cost_of_equipment,purchase_file_id,current_location,manufacturer_supplier,active,status,revision,save_request_id,custom_field_count,custom_fields_provided)
      VALUES(org,target_id,p_code,p_name,p_description,p_laboratory_id,p_make,p_model_name,p_serial_number,p_date_of_installation,p_calibration_agency,p_calibrated,
        p_cost_of_equipment,p_purchase_file_id,p_current_location,p_manufacturer_supplier,p_active,CASE WHEN p_active THEN 'available' ELSE 'retired' END,next_revision,requested_id,p_custom_field_count,p_custom_fields_provided);
  ELSE
    UPDATE public.instruments SET code=p_code,name=p_name,description=p_description,laboratory_id=p_laboratory_id,make=p_make,model_name=p_model_name,serial_number=p_serial_number,
      date_of_installation=p_date_of_installation,calibration_agency=p_calibration_agency,calibrated=p_calibrated,cost_of_equipment=p_cost_of_equipment,purchase_file_id=p_purchase_file_id,
      current_location=p_current_location,manufacturer_supplier=p_manufacturer_supplier,active=p_active,
      custom_field_count=p_custom_field_count,custom_fields_provided=p_custom_fields_provided,
      status=CASE WHEN NOT p_active THEN 'retired' WHEN status='retired' THEN 'available' ELSE status END,
      revision=next_revision,save_request_id=requested_id,updated_at=transaction_timestamp() WHERE organization_id=org AND id=target_id;
  END IF;
  PERFORM public.instruments_record_core(target_id,expected_revision,CASE WHEN expected_revision=0 THEN 'create' ELSE 'update' END,fingerprint,user_count,service_count,p_user_ids IS NOT NULL,p_services_provided);
  PERFORM public.instruments_copy_relations(target_id,expected_revision,next_revision,p_user_ids IS NULL,NOT p_services_provided);
  IF p_user_ids IS NOT NULL THEN
    INSERT INTO public.instrument_version_users(organization_id,instrument_id,revision,user_id,position,user_name,username)
      SELECT org,target_id,next_revision,wanted.id,wanted.position-1,person.display_name,person.username FROM unnest(p_user_ids) WITH ORDINALITY wanted(id,position)
      JOIN public.users person ON person.id=wanted.id;
  END IF;
  IF p_services_provided THEN
    INSERT INTO public.instrument_version_services(organization_id,instrument_id,revision,id,position,service_definition_id,service_definition_revision,service_code,service_label,
      template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count)
      SELECT org,target_id,next_revision,wanted.id,wanted.position-1,definition.id,definition_revision,definition.service_code,definition.display_label,
        wanted.template_id,wanted.workflow_id,template.name,workflow.name,wanted.reminder,wanted.frequency,wanted.last_performed,wanted.reminder_frequency,wanted.next_reminder,wanted.active,
        (SELECT count(*) FROM unnest(p_role_service_ids) role(service_id) WHERE role.service_id=wanted.id)
      FROM unnest(p_service_ids,p_service_codes,p_template_ids,p_workflow_ids,p_reminder_before,p_frequency,p_last_performed,p_reminder_frequency,p_next_reminder,p_service_active)
        WITH ORDINALITY wanted(id,code,template_id,workflow_id,reminder,frequency,last_performed,reminder_frequency,next_reminder,active,position)
      JOIN public.organization_instrument_service_entries definition ON definition.organization_id=org AND definition.revision=definition_revision AND definition.service_code=wanted.code
      LEFT JOIN public.workflows workflow ON workflow.organization_id=org AND workflow.id=wanted.workflow_id
      LEFT JOIN LATERAL (SELECT name FROM public.template_versions WHERE organization_id=org AND template_id=wanted.template_id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1) template ON true;
    INSERT INTO public.instrument_version_service_roles(organization_id,instrument_id,revision,service_id,role_id,position,role_name)
      SELECT org,target_id,next_revision,wanted.service_id,wanted.role_id,row_number() OVER(PARTITION BY wanted.service_id ORDER BY wanted.position)-1,role.name
      FROM unnest(p_role_service_ids,p_role_ids) WITH ORDINALITY wanted(service_id,role_id,position)
      JOIN public.roles role ON role.organization_id=org AND role.id=wanted.role_id;
  END IF;
  RETURN next_revision;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION instruments_retire(target_id uuid,expected_revision integer,requested_id uuid,fingerprint text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.instruments; version public.instrument_versions;
BEGIN
  prior:=public.instruments_prior_request(target_id,expected_revision,requested_id,fingerprint,'retire'); IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO head FROM public.instruments WHERE organization_id=org AND id=target_id FOR UPDATE;
  IF head.id IS NULL OR head.retired THEN RAISE EXCEPTION 'Instrument was not found' USING ERRCODE='P0002',CONSTRAINT='instrument_not_found'; END IF;
  IF expected_revision<1 OR head.revision<>expected_revision THEN
    RAISE EXCEPTION 'Instrument changed; reload before deleting' USING ERRCODE='23514',CONSTRAINT='instrument_stale_revision';
  END IF;
  SELECT * INTO version FROM public.instrument_versions WHERE organization_id=org AND instrument_id=target_id AND revision=expected_revision;
  UPDATE public.instruments SET active=false,retired=true,status='retired',custom_fields_provided=false,revision=revision+1,save_request_id=requested_id,updated_at=transaction_timestamp()
    WHERE organization_id=org AND id=target_id;
  PERFORM public.instruments_record_core(target_id,expected_revision,'retire',fingerprint,version.user_count,version.service_count,false,false);
  PERFORM public.instruments_copy_relations(target_id,expected_revision,expected_revision+1,true,true);
  RETURN expected_revision+1;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION instruments_check_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.instrument_versions;
BEGIN
  SELECT * INTO version FROM public.instrument_versions WHERE organization_id=NEW.organization_id AND instrument_id=NEW.id AND revision=NEW.revision;
  IF version.instrument_id IS NULL OR version.request_id IS DISTINCT FROM NEW.save_request_id OR version.saved_at IS DISTINCT FROM NEW.updated_at
    OR (NEW.code,NEW.name,NEW.description,NEW.laboratory_id,NEW.make,NEW.model_name,NEW.serial_number,NEW.date_of_installation,NEW.calibration_agency,NEW.calibrated,NEW.cost_of_equipment,NEW.purchase_file_id,NEW.current_location,NEW.manufacturer_supplier,NEW.active,NEW.retired,NEW.status,NEW.current_status,NEW.custom_field_count,NEW.custom_fields_provided) IS DISTINCT FROM (version.code,version.name,version.description,version.laboratory_id,version.make,version.model_name,version.serial_number,version.date_of_installation,version.calibration_agency,version.calibrated,version.cost_of_equipment,version.purchase_file_id,version.current_location,version.manufacturer_supplier,version.active,version.retired,version.status,version.current_status,version.custom_field_count,version.custom_fields_provided) THEN
    RAISE EXCEPTION 'Instrument head must match its recorded command' USING ERRCODE='23514',CONSTRAINT='instrument_head_history';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION custom_field_guard_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE definition public.custom_field_definitions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Custom Field attachment bytes are immutable' USING ERRCODE='55000'; END IF;
  IF session_user='sampleify_app' AND current_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  -- The owner-only users command holds the shared definition advisory before account rows.
  -- A raw definition UPDATE can already hold its row while waiting on that advisory.
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id;
  IF definition.associated_with NOT IN ('users','instrument') THEN
    SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id FOR SHARE;
  END IF;
  IF definition.id IS NULL OR NOT definition.active OR definition.field_type<>'attachment'
    OR definition.associated_with NOT IN ('product','parameter','method_of_analysis','users','customer','vendor','instrument') OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires a current active supported field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  IF definition.associated_with IN ('customer','vendor') THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'Party master attachments require their upload command' USING ERRCODE='42501'; END IF;
    IF definition.associated_with='customer' THEN PERFORM public.masters_require_customer_write();
    ELSE PERFORM public.masters_require_vendor_write(); END IF;
    IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope()
      OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'Party master attachments require the actual organization, editor and transaction' USING ERRCODE='42501';
    END IF;
  ELSIF definition.associated_with='instrument' THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'Instrument attachments require their upload command' USING ERRCODE='42501'; END IF;
    IF NEW.uploaded_by IS DISTINCT FROM public.instruments_require_writer()
      OR NEW.organization_id IS DISTINCT FROM public.organization_module_scope()
      OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'Instrument attachment requires the actual tenant, editor and transaction time' USING ERRCODE='42501';
    END IF;
  ELSIF definition.associated_with='users' THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'User attachments require their upload command' USING ERRCODE='42501'; END IF;
    IF NEW.uploaded_by IS DISTINCT FROM public.users_require_manager()
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'User attachment requires the actual tenant, editor and transaction time' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_upload_field_attachment(target_id uuid,target_field uuid,target_revision integer,file_name text,file_type text,file_content bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid; prior public.custom_field_attachments; definition public.custom_field_definitions;
BEGIN
  PERFORM public.instruments_require_writer();
  actor:=nullif(current_setting('app.user_id',true),'')::uuid;
  IF target_id IS NULL OR target_field IS NULL OR target_revision IS NULL OR target_revision<1 OR file_content IS NULL OR octet_length(file_content)>20971520 THEN
    RAISE EXCEPTION 'Invalid Instrument attachment' USING ERRCODE='23514',CONSTRAINT='instrument_attachment_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||org::text||':'||target_id::text,0));
  SELECT * INTO prior FROM public.custom_field_attachments WHERE organization_id=org AND id=target_id;
  IF FOUND THEN
    IF (prior.field_id,prior.field_revision,prior.original_name,prior.media_type,prior.content,prior.uploaded_by)
      IS DISTINCT FROM (target_field,target_revision,file_name,file_type,file_content,actor)
      OR NOT EXISTS (SELECT 1 FROM public.custom_field_versions WHERE organization_id=org AND field_id=prior.field_id AND revision=prior.field_revision AND associated_with='instrument') THEN
      RAISE EXCEPTION 'Attachment request already used' USING ERRCODE='23514',CONSTRAINT='instrument_attachment_request_reused';
    END IF;
    RETURN true;
  END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=org AND id=target_field;
  IF definition.id IS NULL OR NOT definition.active OR definition.associated_with<>'instrument' OR definition.field_type<>'attachment' THEN
    RAISE EXCEPTION 'Instrument attachment field was not found' USING ERRCODE='P0002',CONSTRAINT='instrument_attachment_field_not_found';
  END IF;
  IF definition.revision<>target_revision THEN RAISE EXCEPTION 'Custom Field changed' USING ERRCODE='23514',CONSTRAINT='instrument_attachment_field_changed'; END IF;
  INSERT INTO public.custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,target_id,target_field,target_revision,file_name,file_type,file_content,octet_length(file_content),encode(sha256(file_content),'hex'),actor);
  RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION instruments_scheme_context(include_instruments boolean,include_samples boolean)
RETURNS TABLE("currentYearDigits" text,"nextYearDigits" text,separator text,"currentMonthFormat" text,"nonNablStartNumber" text,
  "instrumentCount" double precision,"sampleCount" double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('instruments.manage') OR NOT public.organization_has_module_access('instrument') THEN
    RAISE EXCEPTION 'Instrument scheme generation requires permission' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.scheme_current_year_digits,settings.scheme_next_year_digits,settings.scheme_separator,
    settings.scheme_month_format,settings.scheme_non_nabl_start_number,
    CASE WHEN include_instruments THEN (SELECT count(*)::double precision FROM public.instruments instrument WHERE instrument.organization_id=org AND NOT instrument.retired) ELSE 0::double precision END,
    CASE WHEN include_samples THEN (SELECT count(*)::double precision FROM public.samples sample WHERE sample.organization_id=org) ELSE 0::double precision END
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=org;
END $$;
--> statement-breakpoint
CREATE VIEW instrument_custom_field_definitions WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,revision,associated_with,active,display_order,label,show_in_list,show_in_filter
  FROM public.custom_field_definitions WHERE associated_with='instrument'
    AND organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL));
--> statement-breakpoint
CREATE VIEW instrument_custom_field_versions WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,field_id,revision,option_count,key,label,description,auto_generated,scheme,
    nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,
    allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,
    associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,
    show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation,lookup_source_id,edit_on_reissue
  FROM public.custom_field_versions WHERE associated_with='instrument'
    AND organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL));
--> statement-breakpoint
CREATE VIEW instrument_custom_field_version_options WITH(security_barrier=true,security_invoker=false) AS
  SELECT choice.organization_id,choice.field_id,choice.revision,choice.id,choice.key,choice.label,choice.position
  FROM public.custom_field_version_options choice JOIN public.custom_field_versions definition
    ON definition.organization_id=choice.organization_id AND definition.field_id=choice.field_id AND definition.revision=choice.revision
  WHERE definition.associated_with='instrument' AND choice.organization_id=(SELECT public.organization_module_scope())
    AND (SELECT public.instruments_can_read(NULL));
--> statement-breakpoint
CREATE VIEW instrument_access_user_labels WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id AS user_id,name AS display_name FROM public.instrument_user_catalog;
--> statement-breakpoint
CREATE VIEW instrument_custom_field_lookup_sources WITH(security_barrier=true,security_invoker=false) AS
  SELECT source.organization_id,source.id,source.revision,source.line_count,observation.line_count AS observed_line_count
  FROM public.custom_field_lookup_sources source LEFT JOIN public.custom_field_lookup_versions observation
    ON observation.organization_id=source.organization_id AND observation.source_id=source.id AND observation.revision=source.revision
  WHERE source.organization_id=(SELECT public.organization_module_scope()) AND (SELECT public.instruments_can_read(NULL)) AND EXISTS (
    SELECT 1 FROM public.custom_field_definitions field WHERE field.organization_id=source.organization_id AND field.active
      AND field.associated_with='instrument' AND field.field_type='lookup' AND field.lookup_source_id=source.id
  );
--> statement-breakpoint
CREATE VIEW instrument_custom_field_lookup_lines WITH(security_barrier=true,security_invoker=false) AS
  SELECT line.organization_id,line.source_id,line.revision,line.original_line_id,line.position,
    line.label_kind,line.label_text,line.label_number,line.label_boolean
  FROM public.custom_field_lookup_lines line JOIN public.instrument_custom_field_lookup_sources source
    ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision;
--> statement-breakpoint
CREATE FUNCTION instruments_can_read_field_attachment(target_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.instruments_can_read(NULL) AND EXISTS (
    SELECT 1 FROM public.custom_field_attachments file JOIN public.custom_field_versions definition
      ON definition.organization_id=file.organization_id AND definition.field_id=file.field_id AND definition.revision=file.field_revision
    WHERE file.organization_id=public.organization_module_scope() AND file.id=target_id
      AND definition.associated_with='instrument' AND definition.field_type='attachment'
      AND (public.app_has_permission('instruments.manage') OR EXISTS (
        SELECT 1 FROM public.instrument_version_custom_field_values value
          WHERE value.organization_id=file.organization_id AND value.attachment_id=file.id AND public.instruments_can_read(value.instrument_id)
      ))
  );
$$;
REVOKE ALL ON FUNCTION instruments_can_read_field_attachment(uuid) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION instruments_can_read_field_attachment(uuid) TO sampleify_app;
--> statement-breakpoint
CREATE VIEW instrument_custom_field_attachments WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by,uploaded_at
  FROM public.custom_field_attachments WHERE organization_id=(SELECT public.organization_module_scope())
    AND public.instruments_can_read_field_attachment(id);
REVOKE ALL ON instrument_custom_field_definitions,instrument_custom_field_versions,instrument_custom_field_version_options,
  instrument_access_user_labels,instrument_custom_field_lookup_sources,instrument_custom_field_lookup_lines,instrument_custom_field_attachments
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON instrument_custom_field_definitions,instrument_custom_field_versions,instrument_custom_field_version_options,
  instrument_access_user_labels,instrument_custom_field_lookup_sources,instrument_custom_field_lookup_lines,instrument_custom_field_attachments TO sampleify_app;

--> statement-breakpoint
DO $$ DECLARE routine record; BEGIN
  FOR routine IN SELECT oid::regprocedure AS signature,proname FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN ('instruments_save_core','instruments_save','instruments_upload_field_attachment','instruments_scheme_context') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,sampleify_app,sampleify_report_worker',routine.signature);
    IF routine.proname<>'instruments_save_core' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sampleify_app',routine.signature); END IF;
  END LOOP;
END $$;
