ALTER TABLE "user_version_custom_field_values" DROP CONSTRAINT "user_custom_value_interpretation";--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD COLUMN "lookup_source_id" uuid;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD COLUMN "lookup_revision" integer;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD COLUMN "lookup_line_id" text;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_lookup_fk" FOREIGN KEY ("organization_id","lookup_source_id","lookup_revision","lookup_line_id") REFERENCES "public"."custom_field_lookup_lines"("organization_id","source_id","revision","original_line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_lookup_reference" CHECK (num_nonnulls("user_version_custom_field_values"."lookup_source_id","user_version_custom_field_values"."lookup_revision","user_version_custom_field_values"."lookup_line_id")=0
    or ("user_version_custom_field_values"."lookup_source_id" is not null and "user_version_custom_field_values"."lookup_revision" is not null and "user_version_custom_field_values"."lookup_revision">0 and "user_version_custom_field_values"."lookup_line_id" is not null));--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_interpretation" CHECK ("user_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("user_version_custom_field_values"."parsed_number" is null or "user_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("user_version_custom_field_values"."parsed_timestamp" is null or isfinite("user_version_custom_field_values"."parsed_timestamp")) and ("user_version_custom_field_values"."parsed_date" is null or isfinite("user_version_custom_field_values"."parsed_date"))
    and (("user_version_custom_field_values"."option_id" is null and "user_version_custom_field_values"."option_revision" is null) or ("user_version_custom_field_values"."option_id" is not null and "user_version_custom_field_values"."option_revision" is not null and "user_version_custom_field_values"."option_revision">0))
    and ("user_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("user_version_custom_field_values"."parsed_number","user_version_custom_field_values"."parsed_boolean","user_version_custom_field_values"."parsed_date","user_version_custom_field_values"."parsed_timestamp","user_version_custom_field_values"."option_id","user_version_custom_field_values"."option_revision","user_version_custom_field_values"."user_id","user_version_custom_field_values"."attachment_id","user_version_custom_field_values"."lookup_source_id","user_version_custom_field_values"."lookup_revision","user_version_custom_field_values"."lookup_line_id")=0)
    and (("user_version_custom_field_values"."interpretation_state"='empty')=("user_version_custom_field_values"."raw_kind"='text' and "user_version_custom_field_values"."raw_text"='')));
--> statement-breakpoint
-- User authority exposes only current choices of active, configured user lookup fields.
CREATE VIEW user_custom_field_lookup_lines WITH (security_barrier=true,security_invoker=false) AS
  SELECT line.organization_id,line.source_id,line.revision,line.original_line_id,line.position,
    line.label_kind,line.label_text,line.label_number,line.label_boolean
  FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
    ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
  WHERE line.organization_id=(SELECT public.users_directory_organization()) AND EXISTS (
    SELECT 1 FROM public.custom_field_definitions field
      WHERE field.organization_id=line.organization_id AND field.active AND field.associated_with='users'
        AND field.field_type='lookup' AND field.lookup_source_id=line.source_id
  );
REVOKE ALL ON user_custom_field_lookup_lines FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON user_custom_field_lookup_lines TO sampleify_app;

--> statement-breakpoint
CREATE FUNCTION masters_lock_lookup_observer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||org::text,0));
  PERFORM 1 FROM public.users WHERE id=actor FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions session
    JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
    JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
    JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
    JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
    WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid AND session.user_id=actor AND session.organization_id=org
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  ) OR NOT public.app_has_permission('masters.manage') THEN
    RAISE EXCEPTION 'Active lookup observation management session required' USING ERRCODE='42501',CONSTRAINT='custom_lookup_session_required';
  END IF;
  RETURN actor;
END $$;
REVOKE ALL ON FUNCTION masters_lock_lookup_observer() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_lock_lookup_observer() TO sampleify_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_track_lookup_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preserve lookup source identities and observations' USING ERRCODE='55000'; END IF;
  IF actor IS NULL OR (session_user='sampleify_app' AND (NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid)) THEN
    RAISE EXCEPTION 'Lookup observations require master management and the actual observer' USING ERRCODE='42501';
  END IF;
  IF session_user='sampleify_app' THEN
    PERFORM public.masters_lock_lookup_observer();
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||NEW.organization_id::text,0));
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_guard_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.user_field_value_versions; field public.user_version_custom_fields; definition public.custom_field_versions;
  related_count integer; previous_field_ids uuid[]; current_field_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'User Custom Field history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO version FROM public.user_field_value_versions WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=NEW.revision;
  IF version.subject_user_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=NEW.organization_id AND user_id=NEW.subject_user_id AND custom_field_revision=NEW.revision) THEN
    RAISE EXCEPTION 'User Custom Fields require their actual new version transaction' USING ERRCODE='23514',CONSTRAINT='user_custom_field_transaction';
  END IF;
  IF TG_TABLE_NAME='user_version_custom_fields' THEN
    IF NEW.position>=version.custom_field_count THEN RAISE EXCEPTION 'User Custom Field position exceeds its saved count' USING ERRCODE='23514'; END IF;
    SELECT * INTO definition FROM public.custom_field_versions
      WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=NEW.field_revision;
    IF NOT FOUND OR definition.field_type<>NEW.field_type THEN
      RAISE EXCEPTION 'User Custom Field type must match its definition' USING ERRCODE='23514',CONSTRAINT='user_custom_field_type';
    END IF;
    IF NEW.field_type IN ('date','date_time') AND NEW.time_zone IS DISTINCT FROM version.time_zone THEN
      RAISE EXCEPTION 'Date fields require their capture time zone' USING ERRCODE='23514',CONSTRAINT='user_custom_field_timezone';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id
        AND revision=NEW.field_revision AND associated_with='users' AND active
    ) THEN RAISE EXCEPTION 'Select the current User Custom Field revision' USING ERRCODE='23514',CONSTRAINT='user_custom_field_definition_set'; END IF;
  ELSE
    SELECT * INTO field FROM public.user_version_custom_fields
      WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=NEW.revision AND field_id=NEW.field_id;
    IF NOT FOUND OR NEW.position>=field.value_count THEN
      RAISE EXCEPTION 'User Custom Field items require their declared field and count' USING ERRCODE='23514',CONSTRAINT='user_custom_value_complete';
    END IF;
    IF field.is_array AND NEW.raw_kind='text' AND public.masters_custom_field_trim(NEW.raw_text)='' THEN
      RAISE EXCEPTION 'Remove blank repeated User Custom Field items' USING ERRCODE='23514';
    END IF;
    NEW.user_username:=NULL; NEW.user_name:=NULL;
    IF field.field_type='lookup' THEN
      SELECT * INTO definition FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      current_field_key:=definition.key;
    END IF;
    related_count := num_nonnulls(NEW.parsed_number,NEW.parsed_boolean,NEW.parsed_date,NEW.parsed_timestamp,NEW.option_id,NEW.option_revision,NEW.user_id,NEW.attachment_id,NEW.lookup_source_id,NEW.lookup_revision,NEW.lookup_line_id);
    IF version.previous_revision>0 AND (
      field.field_type='select' AND (NEW.interpretation_state='invalid' OR NEW.interpretation_state='valid' AND NEW.option_revision<>field.field_revision)
      OR field.field_type='attachment' AND NEW.interpretation_state='valid'
      OR field.field_type='lookup' AND NEW.interpretation_state='invalid'
    ) THEN
      -- Bound retained-item checks by saved-key field IDs before inspecting potentially thousands of prior items.
      IF current_field_key IS NULL THEN
        SELECT key INTO current_field_key FROM public.custom_field_versions
        WHERE organization_id=NEW.organization_id AND field_id=NEW.field_id AND revision=field.field_revision;
      END IF;
      WITH key_definitions AS MATERIALIZED (
        SELECT field_id,revision FROM public.custom_field_versions WHERE organization_id=NEW.organization_id AND key=current_field_key
      ) SELECT array_agg(previous_field.field_id) INTO previous_field_ids
        FROM key_definitions previous_definition JOIN LATERAL (
          -- Each captured field has one primary-key row; keep this lookup parameterized in cached plans.
          SELECT field_id FROM public.user_version_custom_fields
            WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=version.previous_revision
              AND field_id=previous_definition.field_id AND field_revision=previous_definition.revision LIMIT 1
        ) previous_field ON true;
    END IF;
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
          IF NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.user_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
              AND previous.field_id=ANY(previous_field_ids)
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
          ) THEN RAISE EXCEPTION 'An older selection must belong to the previous User revision' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
        WHEN 'multi_user_select' THEN
          IF NEW.user_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.user_id::text THEN
            RAISE EXCEPTION 'A user selection requires its member reference' USING ERRCODE='23514',CONSTRAINT='user_custom_value_user';
          END IF;
          SELECT person.username,person.display_name INTO NEW.user_username,NEW.user_name
            FROM public.memberships member JOIN public.users person ON person.id=member.user_id
            WHERE member.organization_id=NEW.organization_id AND member.user_id=NEW.user_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'Select users in this organization' USING ERRCODE='23514',CONSTRAINT='user_custom_value_user'; END IF;
        WHEN 'attachment' THEN
          IF NEW.attachment_id IS NULL OR related_count<>1 OR NEW.raw_kind<>'text' OR lower(NEW.raw_text)<>NEW.attachment_id::text OR NOT EXISTS (
            SELECT 1 FROM public.custom_field_attachments attachment JOIN public.custom_field_versions uploaded_definition
              ON uploaded_definition.organization_id=attachment.organization_id AND uploaded_definition.field_id=attachment.field_id AND uploaded_definition.revision=attachment.field_revision
              WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id
                AND (attachment.field_id=NEW.field_id
                  -- The original uploaded definition records the draft's saved key even before its first capture.
                  OR uploaded_definition.key=coalesce(current_field_key, (
                    SELECT key FROM public.custom_field_versions WHERE organization_id=NEW.organization_id
                      AND field_id=NEW.field_id AND revision=field.field_revision
                  )) OR EXISTS (
                  SELECT 1 FROM public.user_version_custom_field_values previous
                  WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
                    AND previous.field_id=ANY(previous_field_ids)
                    AND previous.attachment_id=NEW.attachment_id
                ))
                AND uploaded_definition.associated_with='users' AND uploaded_definition.field_type='attachment'
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='user_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN
          IF NEW.lookup_source_id IS NULL OR NEW.lookup_revision IS NULL OR NEW.lookup_line_id IS NULL OR related_count<>3
            OR definition.lookup_source_id IS DISTINCT FROM NEW.lookup_source_id
            OR NEW.lookup_line_id IS DISTINCT FROM (CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END)
            OR NOT EXISTS (
              SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
                ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
              WHERE line.organization_id=NEW.organization_id AND line.source_id=NEW.lookup_source_id
                AND line.revision=NEW.lookup_revision AND line.original_line_id=NEW.lookup_line_id
            ) THEN RAISE EXCEPTION 'A lookup requires the current observed line of its field source' USING ERRCODE='23514',CONSTRAINT='user_custom_value_lookup'; END IF;
        ELSE
          IF related_count<>0 THEN RAISE EXCEPTION 'Text fields cannot contain another field type interpretation' USING ERRCODE='23514'; END IF;
      END CASE;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='select' THEN
      -- Preserve an unresolved previous raw value by saved key, without inventing a cross-definition option reference.
      IF EXISTS (
        SELECT 1 FROM public.custom_field_version_options option WHERE option.organization_id=NEW.organization_id
          AND option.field_id=NEW.field_id AND option.revision=field.field_revision
          AND option.key=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      ) OR NOT EXISTS (
        SELECT 1 FROM public.user_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
          AND previous.field_id=ANY(previous_field_ids)
          AND (previous.field_id<>NEW.field_id OR previous.option_id IS NULL)
          AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
            IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unresolved selection requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
    ELSIF NEW.interpretation_state='invalid' AND field.field_type='lookup' THEN
      IF EXISTS (
        SELECT 1 FROM public.custom_field_lookup_lines line JOIN public.custom_field_lookup_sources source
          ON source.organization_id=line.organization_id AND source.id=line.source_id AND source.revision=line.revision
        WHERE line.organization_id=NEW.organization_id AND line.source_id=definition.lookup_source_id
          AND line.original_line_id=CASE NEW.raw_kind WHEN 'text' THEN NEW.raw_text WHEN 'number' THEN NEW.raw_number_text ELSE NEW.raw_boolean::text END
      ) OR NOT EXISTS (
        SELECT 1 FROM public.user_version_custom_field_values previous
          WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
            AND previous.field_id=ANY(previous_field_ids)
            AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean,previous.raw_number_text)
              IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean,NEW.raw_number_text)
      ) THEN RAISE EXCEPTION 'An unavailable lookup requires the same previous saved-key value' USING ERRCODE='23514',CONSTRAINT='user_custom_value_lookup'; END IF;
    ELSIF NEW.interpretation_state IN ('invalid','out_of_range') AND field.field_type NOT IN ('number','date','date_time') THEN
      RAISE EXCEPTION 'Only numeric and date fields retain invalid interpretations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
