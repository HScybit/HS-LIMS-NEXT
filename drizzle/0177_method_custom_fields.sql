-- Configured Method fields use explicit typed version children. Existing histories remain unaltered.
CREATE TABLE "method_version_custom_field_values" (
	"organization_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
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
	CONSTRAINT "method_custom_value_pk" PRIMARY KEY("organization_id","method_id","revision","field_id","position"),
	CONSTRAINT "method_custom_value_raw" CHECK ("method_version_custom_field_values"."position" between 0 and 499 and num_nonnulls("method_version_custom_field_values"."raw_text","method_version_custom_field_values"."raw_number","method_version_custom_field_values"."raw_boolean")=1
    and (("method_version_custom_field_values"."raw_kind"='text' and "method_version_custom_field_values"."raw_text" is not null and length("method_version_custom_field_values"."raw_text")<=16000)
      or ("method_version_custom_field_values"."raw_kind"='number' and "method_version_custom_field_values"."raw_number" is not null and "method_version_custom_field_values"."raw_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("method_version_custom_field_values"."raw_kind"='boolean' and "method_version_custom_field_values"."raw_boolean" is not null))),
	CONSTRAINT "method_custom_value_number_text" CHECK (case when "method_version_custom_field_values"."raw_kind"='number' then
    "method_version_custom_field_values"."raw_number_text" is not null and length("method_version_custom_field_values"."raw_number_text") between 1 and 32
    and case when "method_version_custom_field_values"."raw_number_text" ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then "method_version_custom_field_values"."raw_number_text"::double precision="method_version_custom_field_values"."raw_number" else false end
    else "method_version_custom_field_values"."raw_number_text" is null end),
	CONSTRAINT "method_custom_value_interpretation" CHECK ("method_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("method_version_custom_field_values"."parsed_number" is null or "method_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("method_version_custom_field_values"."parsed_timestamp" is null or isfinite("method_version_custom_field_values"."parsed_timestamp")) and ("method_version_custom_field_values"."parsed_date" is null or isfinite("method_version_custom_field_values"."parsed_date"))
    and (("method_version_custom_field_values"."option_id" is null and "method_version_custom_field_values"."option_revision" is null) or ("method_version_custom_field_values"."option_id" is not null and "method_version_custom_field_values"."option_revision" is not null and "method_version_custom_field_values"."option_revision">0))
    and ("method_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("method_version_custom_field_values"."parsed_number","method_version_custom_field_values"."parsed_boolean","method_version_custom_field_values"."parsed_date","method_version_custom_field_values"."parsed_timestamp","method_version_custom_field_values"."option_id","method_version_custom_field_values"."option_revision","method_version_custom_field_values"."user_id","method_version_custom_field_values"."attachment_id")=0)
    and (("method_version_custom_field_values"."interpretation_state"='empty')=("method_version_custom_field_values"."raw_kind"='text' and "method_version_custom_field_values"."raw_text"='')))
);
--> statement-breakpoint
CREATE TABLE "method_version_custom_fields" (
	"organization_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
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
	CONSTRAINT "method_custom_field_pk" PRIMARY KEY("organization_id","method_id","revision","field_id"),
	CONSTRAINT "method_custom_field_position" UNIQUE("organization_id","method_id","revision","position"),
	CONSTRAINT "method_custom_field_shape" CHECK ("method_version_custom_fields"."position" between 0 and 499 and "method_version_custom_fields"."value_count" between 0 and 500
    and ("method_version_custom_fields"."is_array" or "method_version_custom_fields"."value_count"=1)
    and "method_version_custom_fields"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')),
	CONSTRAINT "method_custom_field_display" CHECK (num_nonnulls("method_version_custom_fields"."display_text","method_version_custom_fields"."display_number","method_version_custom_fields"."display_boolean")=1
    and (("method_version_custom_fields"."display_kind"='text' and "method_version_custom_fields"."display_text" is not null and length("method_version_custom_fields"."display_text")<=8000998)
      or ("method_version_custom_fields"."display_kind"='number' and "method_version_custom_fields"."display_number" is not null and "method_version_custom_fields"."display_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("method_version_custom_fields"."display_kind"='boolean' and "method_version_custom_fields"."display_boolean" is not null))
    and (not "method_version_custom_fields"."is_array" or "method_version_custom_fields"."display_kind"='text')),
	CONSTRAINT "method_custom_field_zone" CHECK (("method_version_custom_fields"."field_type" in ('date','date_time') and "method_version_custom_fields"."time_zone" is not null
      and length("method_version_custom_fields"."time_zone") between 1 and 100 and "method_version_custom_fields"."time_zone_data_version" is not null and length("method_version_custom_fields"."time_zone_data_version") between 1 and 40
      and "method_version_custom_fields"."date_parser_version" is not null and length("method_version_custom_fields"."date_parser_version") between 1 and 80)
    or ("method_version_custom_fields"."field_type" not in ('date','date_time') and num_nonnulls("method_version_custom_fields"."time_zone","method_version_custom_fields"."time_zone_data_version","method_version_custom_fields"."date_parser_version")=0))
);
--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "method_versions" ADD COLUMN "custom_field_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "method_versions" ADD COLUMN "custom_fields_provided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_version_custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_field_fk" FOREIGN KEY ("organization_id","method_id","revision","field_id") REFERENCES "public"."method_version_custom_fields"("organization_id","method_id","revision","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_option_fk" FOREIGN KEY ("organization_id","field_id","option_revision","option_id") REFERENCES "public"."custom_field_version_options"("organization_id","field_id","revision","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."custom_field_attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_fields" ADD CONSTRAINT "method_version_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_fields" ADD CONSTRAINT "method_custom_field_method_fk" FOREIGN KEY ("organization_id","method_id","revision") REFERENCES "public"."method_versions"("organization_id","method_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "method_version_custom_fields" ADD CONSTRAINT "method_custom_field_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "method_custom_value_raw_search" ON "method_version_custom_field_values" USING btree ("organization_id","field_id",md5("raw_text"),"method_id","revision") WHERE "method_version_custom_field_values"."raw_text" is not null;--> statement-breakpoint
CREATE INDEX "method_custom_field_definition" ON "method_version_custom_fields" USING btree ("organization_id","field_id","method_id","revision");--> statement-breakpoint
ALTER TABLE "methods_of_analysis" ADD CONSTRAINT "method_custom_field_count" CHECK ("methods_of_analysis"."custom_field_count" between 0 and 500);--> statement-breakpoint
ALTER TABLE "method_versions" ADD CONSTRAINT "method_version_custom_fields" CHECK ("method_versions"."custom_field_count" between 0 and 500 and ("method_versions"."operation"<>'retire' or not "method_versions"."custom_fields_provided"));
--> statement-breakpoint
-- Method fields use concrete version relationships and the same GenericForm value rules as Product.
ALTER TABLE "method_version_custom_field_values" DROP CONSTRAINT "method_custom_value_interpretation";
--> statement-breakpoint

ALTER TABLE "method_version_custom_field_values" ADD COLUMN "lookup_source_id" uuid;
--> statement-breakpoint

ALTER TABLE "method_version_custom_field_values" ADD COLUMN "lookup_revision" integer;
--> statement-breakpoint

ALTER TABLE "method_version_custom_field_values" ADD COLUMN "lookup_line_id" text;
--> statement-breakpoint

ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_lookup_reference" CHECK (num_nonnulls("method_version_custom_field_values"."lookup_source_id","method_version_custom_field_values"."lookup_revision","method_version_custom_field_values"."lookup_line_id")=0
    or ("method_version_custom_field_values"."lookup_source_id" is not null and "method_version_custom_field_values"."lookup_revision" is not null and "method_version_custom_field_values"."lookup_revision">0 and "method_version_custom_field_values"."lookup_line_id" is not null));
--> statement-breakpoint

ALTER TABLE "method_version_custom_field_values" ADD CONSTRAINT "method_custom_value_interpretation" CHECK ("method_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("method_version_custom_field_values"."parsed_number" is null or "method_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("method_version_custom_field_values"."parsed_timestamp" is null or isfinite("method_version_custom_field_values"."parsed_timestamp")) and ("method_version_custom_field_values"."parsed_date" is null or isfinite("method_version_custom_field_values"."parsed_date"))
    and (("method_version_custom_field_values"."option_id" is null and "method_version_custom_field_values"."option_revision" is null) or ("method_version_custom_field_values"."option_id" is not null and "method_version_custom_field_values"."option_revision" is not null and "method_version_custom_field_values"."option_revision">0))
    and ("method_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("method_version_custom_field_values"."parsed_number","method_version_custom_field_values"."parsed_boolean","method_version_custom_field_values"."parsed_date","method_version_custom_field_values"."parsed_timestamp","method_version_custom_field_values"."option_id","method_version_custom_field_values"."option_revision","method_version_custom_field_values"."user_id","method_version_custom_field_values"."attachment_id","method_version_custom_field_values"."lookup_source_id","method_version_custom_field_values"."lookup_revision","method_version_custom_field_values"."lookup_line_id")=0)
    and (("method_version_custom_field_values"."interpretation_state"='empty')=("method_version_custom_field_values"."raw_kind"='text' and "method_version_custom_field_values"."raw_text"='')));
--> statement-breakpoint
CREATE FUNCTION masters_lock_method_field_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'Method field writes require a current snapshot' USING ERRCODE='25001',CONSTRAINT='method_field_write_isolation';
  END IF;
  RETURN public.masters_lock_field_writer();
END $$;
REVOKE ALL ON FUNCTION masters_lock_method_field_writer() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_lock_method_field_writer() TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION masters_assert_method_custom_fields(target_organization uuid,target_method uuid,target_revision integer,check_definition_set boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.method_versions; field_count integer; minimum_position integer; maximum_position integer; item_count integer;
BEGIN
  SELECT * INTO version FROM public.method_versions
    WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Method Custom Field history is missing' USING ERRCODE='23514',CONSTRAINT='method_custom_field_complete'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(value_count),0) INTO field_count,minimum_position,maximum_position,item_count
    FROM public.method_version_custom_fields
    WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision;
  IF field_count<>version.custom_field_count OR item_count>5000
    OR (field_count>0 AND (minimum_position<>0 OR maximum_position<>field_count-1)) THEN
    RAISE EXCEPTION 'Method Custom Fields require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='method_custom_field_complete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.method_version_custom_fields field LEFT JOIN LATERAL (
      SELECT count(*) AS count,min(position) AS minimum,max(position) AS maximum
      FROM public.method_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.method_id=field.method_id
        AND value.revision=field.revision AND value.field_id=field.field_id
    ) items ON true
    WHERE field.organization_id=target_organization AND field.method_id=target_method AND field.revision=target_revision
      AND (items.count<>field.value_count OR (items.count>0 AND (items.minimum<>0 OR items.maximum<>items.count-1)))
  ) THEN RAISE EXCEPTION 'Method Custom Field items require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='method_custom_value_complete'; END IF;
  IF version.custom_fields_provided THEN
    IF check_definition_set AND (EXISTS (
      SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='method_of_analysis'
      EXCEPT SELECT field_id,field_revision FROM public.method_version_custom_fields
        WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision
    ) OR EXISTS (
      SELECT field_id,field_revision FROM public.method_version_custom_fields
        WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision
      EXCEPT SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='method_of_analysis'
    )) THEN RAISE EXCEPTION 'Method Custom Field definitions changed' USING ERRCODE='23514',CONSTRAINT='method_custom_field_definition_set'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.method_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      WHERE field.organization_id=target_organization AND field.method_id=target_method AND field.revision=target_revision AND definition.is_required
      AND NOT (
        (field.is_array AND definition.field_type<>'multi_user_select'
          AND (NOT definition.allows_multiple OR definition.field_type='attachment'))
        OR EXISTS (
        SELECT 1 FROM public.method_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.method_id=field.method_id AND value.revision=field.revision AND value.field_id=field.field_id
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
    ) THEN RAISE EXCEPTION 'A required Method Custom Field is empty' USING ERRCODE='23514',CONSTRAINT='method_custom_field_required'; END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_guard_method_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  PERFORM public.masters_lock_method_field_writer();
  IF NEW.organization_id IS DISTINCT FROM public.organization_module_scope() THEN
    RAISE EXCEPTION 'Method fields require the authenticated organization' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.method_versions WHERE organization_id=OLD.organization_id AND method_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_method_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF NOT NEW.active AND NEW.custom_fields_provided THEN
    RAISE EXCEPTION 'Method retirement preserves Custom Fields' USING ERRCODE='23514',CONSTRAINT='method_custom_field_preserve';
  END IF;
  IF NEW.custom_fields_provided THEN
    SELECT count(*) INTO expected_count FROM public.custom_field_definitions
      WHERE organization_id=NEW.organization_id AND associated_with='method_of_analysis' AND active;
    IF expected_count<>NEW.custom_field_count THEN
      RAISE EXCEPTION 'Provide the current Method Custom Fields' USING ERRCODE='23514',CONSTRAINT='method_custom_field_definition_set';
    END IF;
  ELSE
    expected_count := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.custom_field_count END;
    IF NEW.custom_field_count<>expected_count OR (NEW.active AND EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND associated_with='method_of_analysis' AND active
    )) THEN RAISE EXCEPTION 'Method Custom Field omission requires no current definitions' USING ERRCODE='23514',CONSTRAINT='method_custom_field_preserve'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER master_method_custom_field_change BEFORE INSERT OR UPDATE ON methods_of_analysis
  FOR EACH ROW EXECUTE FUNCTION masters_guard_method_custom_field_change();
--> statement-breakpoint
CREATE FUNCTION masters_initialize_method_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE method public.methods_of_analysis;
BEGIN
  SELECT * INTO method FROM public.methods_of_analysis WHERE organization_id=NEW.organization_id AND id=NEW.method_id AND revision=NEW.revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Method field history requires its actual Method revision' USING ERRCODE='23514'; END IF;
  NEW.custom_field_count := method.custom_field_count;
  NEW.custom_fields_provided := method.custom_fields_provided;
  RETURN NEW;
END $$;
CREATE TRIGGER method_custom_field_metadata BEFORE INSERT ON method_versions
  FOR EACH ROW EXECUTE FUNCTION masters_initialize_method_custom_field_metadata();
--> statement-breakpoint
CREATE FUNCTION masters_guard_method_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.method_versions; field public.method_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Method Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.method_versions WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision;
  IF version.method_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.methods_of_analysis WHERE organization_id=NEW.organization_id AND id=NEW.method_id
        AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
    RAISE EXCEPTION 'Method Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='method_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='method_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Method Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Method Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='method_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='method_of_analysis' AND active
    ) THEN RAISE EXCEPTION 'Select the current Method Custom Field revision' USING ERRCODE='23514',CONSTRAINT='method_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.method_version_custom_fields
      WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Method Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='method_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Method Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.method_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id
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
          SELECT field_id FROM public.method_version_custom_fields
            WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=version.previous_revision
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
            SELECT field_id FROM public.method_version_custom_fields
              WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=version.previous_revision
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='method_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.method_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Method revision' USING ERRCODE='23514',CONSTRAINT='method_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='method_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id
                AND uploaded_definition.revision=attachment.field_revision
            WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
              AND uploaded_definition.associated_with IN ('product','method') AND uploaded_definition.field_type='attachment'
              AND (attachment.field_id=NEW.field_id OR uploaded_definition.key=definition.key OR EXISTS (
                SELECT 1 FROM public.method_version_custom_field_values previous
                WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id
                  AND previous.revision=version.previous_revision AND previous.field_id=ANY(previous_field_ids)
                  AND previous.attachment_id=NEW.attachment_id
              ))
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='method_custom_value_attachment'; END IF;
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
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='method_custom_value_lookup'; END IF;
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
        SELECT 1 FROM public.method_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='method_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.method_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.method_id=NEW.method_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='method_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['method_version_custom_fields','method_version_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY method_custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope())
        AND (SELECT app_has_permission(''masters.read'') OR app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('CREATE POLICY method_custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id IS NOT DISTINCT FROM (SELECT organization_module_scope()) AND (SELECT app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_report_worker',relation);
    EXECUTE format('CREATE TRIGGER method_custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION masters_guard_method_custom_field_history()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_assert_method_custom_field_preservation(target_organization uuid,target_method uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.method_versions;
BEGIN
  SELECT * INTO version FROM public.method_versions WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","method_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.method_version_custom_fields WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision EXCEPT SELECT "organization_id","method_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.method_version_custom_fields WHERE organization_id=target_organization AND method_id=target_method AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","method_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.method_version_custom_fields WHERE organization_id=target_organization AND method_id=target_method AND revision=version.previous_revision EXCEPT SELECT "organization_id","method_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.method_version_custom_fields WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision) OR EXISTS (SELECT "organization_id","method_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.method_version_custom_field_values WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision EXCEPT SELECT "organization_id","method_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.method_version_custom_field_values WHERE organization_id=target_organization AND method_id=target_method AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","method_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.method_version_custom_field_values WHERE organization_id=target_organization AND method_id=target_method AND revision=version.previous_revision EXCEPT SELECT "organization_id","method_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.method_version_custom_field_values WHERE organization_id=target_organization AND method_id=target_method AND revision=target_revision) THEN
    RAISE EXCEPTION 'Method Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='method_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_preserve_method_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.method_version_custom_fields("organization_id","method_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","method_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.method_version_custom_fields
    WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.previous_revision;
  INSERT INTO public.method_version_custom_field_values("organization_id","method_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id")
    SELECT "organization_id","method_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.method_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER method_custom_fields_preserve AFTER INSERT ON method_versions FOR EACH ROW EXECUTE FUNCTION masters_preserve_method_custom_fields();
--> statement-breakpoint
CREATE FUNCTION masters_check_method_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_assert_method_custom_fields(NEW.organization_id,NEW.method_id,NEW.revision,true);
  PERFORM public.masters_assert_method_custom_field_preservation(NEW.organization_id,NEW.method_id,NEW.revision);
  -- The source Method consumer has no custom-field uniqueness association.
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER method_custom_fields_complete AFTER INSERT ON method_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_method_custom_fields();
REVOKE ALL ON FUNCTION masters_assert_method_custom_fields(uuid,uuid,integer,boolean),masters_guard_method_custom_field_change(),
  masters_initialize_method_custom_field_metadata(),masters_guard_method_custom_field_history(),
  masters_assert_method_custom_field_preservation(uuid,uuid,integer),masters_preserve_method_custom_fields(),masters_check_method_custom_fields()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
-- Only the scheme settings and counts required by Method generation are exposed.
CREATE FUNCTION masters_method_scheme_context(include_methods boolean,include_samples boolean)
RETURNS TABLE("currentYearDigits" text,"nextYearDigits" text,separator text,"currentMonthFormat" text,"nonNablStartNumber" text,
  "methodCount" double precision,"sampleCount" double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('masters.manage') THEN
    RAISE EXCEPTION 'Method scheme generation requires permission' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.scheme_current_year_digits,settings.scheme_next_year_digits,settings.scheme_separator,
    settings.scheme_month_format,settings.scheme_non_nabl_start_number,
    CASE WHEN include_methods THEN (SELECT count(*)::double precision FROM public.methods_of_analysis method WHERE method.organization_id=org AND method.active) ELSE 0::double precision END,
    CASE WHEN include_samples THEN (SELECT count(*)::double precision FROM public.samples sample WHERE sample.organization_id=org) ELSE 0::double precision END
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=org;
END $$;
REVOKE ALL ON FUNCTION masters_method_scheme_context(boolean,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_method_scheme_context(boolean,boolean) TO sampleify_app;
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
  IF definition.associated_with IS DISTINCT FROM 'users' THEN
    SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id FOR SHARE;
  END IF;
  IF definition.id IS NULL OR NOT definition.active OR definition.field_type<>'attachment'
    OR definition.associated_with NOT IN ('product','parameter','method_of_analysis','users') OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires a current active supported field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  IF definition.associated_with='users' THEN
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
ALTER POLICY custom_field_attachment_read ON custom_field_attachments USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage'))
  AND EXISTS (SELECT 1 FROM custom_field_versions definition
    WHERE definition.organization_id=custom_field_attachments.organization_id AND definition.field_id=custom_field_attachments.field_id
      AND definition.revision=custom_field_attachments.field_revision AND definition.associated_with IN ('product','parameter','method_of_analysis') AND definition.field_type='attachment')
);


