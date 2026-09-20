ALTER TABLE "parameter_version_custom_field_values" DROP CONSTRAINT "parameter_custom_value_interpretation";--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" DROP CONSTRAINT "product_custom_value_interpretation";--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD COLUMN "lookup_source_id" uuid;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD COLUMN "lookup_revision" integer;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD COLUMN "lookup_line_id" text;--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" ADD COLUMN "lookup_source_id" uuid;--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" ADD COLUMN "lookup_revision" integer;--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" ADD COLUMN "lookup_line_id" text;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" ADD CONSTRAINT "product_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_lookup_reference" CHECK (num_nonnulls("parameter_version_custom_field_values"."lookup_source_id","parameter_version_custom_field_values"."lookup_revision","parameter_version_custom_field_values"."lookup_line_id")=0
    or ("parameter_version_custom_field_values"."lookup_source_id" is not null and "parameter_version_custom_field_values"."lookup_revision" is not null and "parameter_version_custom_field_values"."lookup_revision">0 and "parameter_version_custom_field_values"."lookup_line_id" is not null));--> statement-breakpoint
ALTER TABLE "parameter_version_custom_field_values" ADD CONSTRAINT "parameter_custom_value_interpretation" CHECK ("parameter_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("parameter_version_custom_field_values"."parsed_number" is null or "parameter_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("parameter_version_custom_field_values"."parsed_timestamp" is null or isfinite("parameter_version_custom_field_values"."parsed_timestamp")) and ("parameter_version_custom_field_values"."parsed_date" is null or isfinite("parameter_version_custom_field_values"."parsed_date"))
    and (("parameter_version_custom_field_values"."option_id" is null and "parameter_version_custom_field_values"."option_revision" is null) or ("parameter_version_custom_field_values"."option_id" is not null and "parameter_version_custom_field_values"."option_revision" is not null and "parameter_version_custom_field_values"."option_revision">0))
    and ("parameter_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("parameter_version_custom_field_values"."parsed_number","parameter_version_custom_field_values"."parsed_boolean","parameter_version_custom_field_values"."parsed_date","parameter_version_custom_field_values"."parsed_timestamp","parameter_version_custom_field_values"."option_id","parameter_version_custom_field_values"."option_revision","parameter_version_custom_field_values"."user_id","parameter_version_custom_field_values"."attachment_id","parameter_version_custom_field_values"."lookup_source_id","parameter_version_custom_field_values"."lookup_revision","parameter_version_custom_field_values"."lookup_line_id")=0)
    and (("parameter_version_custom_field_values"."interpretation_state"='empty')=("parameter_version_custom_field_values"."raw_kind"='text' and "parameter_version_custom_field_values"."raw_text"='')));--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" ADD CONSTRAINT "product_custom_value_lookup_reference" CHECK (num_nonnulls("product_version_custom_field_values"."lookup_source_id","product_version_custom_field_values"."lookup_revision","product_version_custom_field_values"."lookup_line_id")=0
    or ("product_version_custom_field_values"."lookup_source_id" is not null and "product_version_custom_field_values"."lookup_revision" is not null and "product_version_custom_field_values"."lookup_revision">0 and "product_version_custom_field_values"."lookup_line_id" is not null));--> statement-breakpoint
ALTER TABLE "product_version_custom_field_values" ADD CONSTRAINT "product_custom_value_interpretation" CHECK ("product_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("product_version_custom_field_values"."parsed_number" is null or "product_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("product_version_custom_field_values"."parsed_timestamp" is null or isfinite("product_version_custom_field_values"."parsed_timestamp")) and ("product_version_custom_field_values"."parsed_date" is null or isfinite("product_version_custom_field_values"."parsed_date"))
    and (("product_version_custom_field_values"."option_id" is null and "product_version_custom_field_values"."option_revision" is null) or ("product_version_custom_field_values"."option_id" is not null and "product_version_custom_field_values"."option_revision" is not null and "product_version_custom_field_values"."option_revision">0))
    and ("product_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("product_version_custom_field_values"."parsed_number","product_version_custom_field_values"."parsed_boolean","product_version_custom_field_values"."parsed_date","product_version_custom_field_values"."parsed_timestamp","product_version_custom_field_values"."option_id","product_version_custom_field_values"."option_revision","product_version_custom_field_values"."user_id","product_version_custom_field_values"."attachment_id","product_version_custom_field_values"."lookup_source_id","product_version_custom_field_values"."lookup_revision","product_version_custom_field_values"."lookup_line_id")=0)
    and (("product_version_custom_field_values"."interpretation_state"='empty')=("product_version_custom_field_values"."raw_kind"='text' and "product_version_custom_field_values"."raw_text"='')));
--> statement-breakpoint
-- New captures pin current lookup lines; omitted fields copy and compare every historical reference.
CREATE OR REPLACE FUNCTION masters_guard_product_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.product_versions; field public.product_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Product Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.product_versions WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.revision;
  IF version.product_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR (session_user='sampleify_app' AND (version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR NOT EXISTS (SELECT 1 FROM public.products WHERE organization_id=NEW.organization_id AND id=NEW.product_id
        AND revision=NEW.revision AND save_request_id=version.request_id))) THEN
    RAISE EXCEPTION 'Product Custom Fields require their new version transaction' USING ERRCODE='23514',CONSTRAINT='product_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='product_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'Product Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'Product Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='product_custom_field_type';
    END IF;
    IF version.custom_fields_provided AND NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='product' AND active
    ) THEN RAISE EXCEPTION 'Select the current Product Custom Field revision' USING ERRCODE='23514',CONSTRAINT='product_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.product_version_custom_fields
      WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'Product Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='product_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated Product Custom Field items' USING ERRCODE='23514';
    END IF;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.product_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='product_custom_value_option'; END IF;
          IF version.custom_fields_provided AND NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.product_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id AND previous.revision=version.previous_revision
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous Product revision' USING ERRCODE='23514',CONSTRAINT='product_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='product_custom_value_user';
          END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id AND attachment.field_id=NEW.field_id
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='product_custom_value_attachment'; END IF;
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
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='product_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.product_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.product_id=NEW.product_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='product_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_assert_product_custom_field_preservation(target_organization uuid,target_product uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.product_versions;
BEGIN
  SELECT * INTO version FROM public.product_versions WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","product_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.product_version_custom_fields WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision EXCEPT SELECT "organization_id","product_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.product_version_custom_fields WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","product_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.product_version_custom_fields WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision EXCEPT SELECT "organization_id","product_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.product_version_custom_fields WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision) OR EXISTS (SELECT "organization_id","product_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.product_version_custom_field_values WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision EXCEPT SELECT "organization_id","product_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.product_version_custom_field_values WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","product_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.product_version_custom_field_values WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision EXCEPT SELECT "organization_id","product_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.product_version_custom_field_values WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision) THEN
    RAISE EXCEPTION 'Product Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='product_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_preserve_product_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.product_version_custom_fields("organization_id","product_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","product_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.product_version_custom_fields
    WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.previous_revision;
  INSERT INTO public.product_version_custom_field_values("organization_id","product_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id")
    SELECT "organization_id","product_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.product_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_guard_parameter_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions; field public.parameter_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[];
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
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      IF NEW.interpretation_state='invalid' AND version.previous_revision>0 THEN
        SELECT array_agg(previous.field_id) INTO previous_field_ids
          FROM public.parameter_version_custom_fields previous JOIN public.custom_field_versions saved_definition
            ON saved_definition.organization_id=previous.organization_id AND saved_definition.field_id=previous.field_id
              AND saved_definition.revision=previous.field_revision
          WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id
            AND previous.revision=version.previous_revision AND saved_definition.key=definition.key;
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
            ) THEN RAISE EXCEPTION 'A lookup requires its exact observed line and current source for a new capture' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      -- Newly supplied captures use current choices; omitted fields preserve their exact frozen interpretation.
      IF (version.custom_fields_provided AND EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      )) OR NOT EXISTS (
        SELECT 1 FROM public.parameter_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.parameter_id=NEW.parameter_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='parameter_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_assert_parameter_custom_field_preservation(target_organization uuid,target_parameter uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.test_parameter_versions;
BEGIN
  SELECT * INTO version FROM public.test_parameter_versions WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision;
  IF version.custom_fields_provided THEN RETURN; END IF;
  IF EXISTS (SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision EXCEPT SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision EXCEPT SELECT "organization_id","parameter_id","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision) OR EXISTS (SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision EXCEPT SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision) OR EXISTS (SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=version.previous_revision EXCEPT SELECT "organization_id","parameter_id","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.parameter_version_custom_field_values WHERE organization_id=target_organization AND parameter_id=target_parameter AND revision=target_revision) THEN
    RAISE EXCEPTION 'Parameter Custom Field omission and retirement preserve every prior field and item' USING ERRCODE='23514',CONSTRAINT='parameter_custom_field_preserve';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_preserve_parameter_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_fields_provided OR NEW.previous_revision IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.parameter_version_custom_fields("organization_id","parameter_id","revision","field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version")
    SELECT "organization_id","parameter_id",NEW.revision,"field_id","field_revision","field_type","position","is_array","value_count","display_kind","display_text","display_number","display_boolean","time_zone","time_zone_data_version","date_parser_version" FROM public.parameter_version_custom_fields
    WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision;
  INSERT INTO public.parameter_version_custom_field_values("organization_id","parameter_id","revision","field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id")
    SELECT "organization_id","parameter_id",NEW.revision,"field_id","position","raw_kind","raw_text","raw_number","raw_boolean","raw_number_text","interpretation_state","parsed_number","parsed_boolean","parsed_date","parsed_timestamp","option_id","option_revision","user_id","attachment_id","lookup_source_id","lookup_revision","lookup_line_id" FROM public.parameter_version_custom_field_values
    WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision;
  RETURN NEW;
END $$;
