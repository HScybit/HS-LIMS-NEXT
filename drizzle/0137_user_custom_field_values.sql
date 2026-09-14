CREATE TABLE "user_field_value_versions" (
	"organization_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer NOT NULL,
	"custom_field_count" integer NOT NULL,
	"time_zone" text,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_by_username" text NOT NULL,
	"saved_by_name" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "user_field_value_version_pk" PRIMARY KEY("organization_id","subject_user_id","revision"),
	CONSTRAINT "user_field_value_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "user_field_value_version" CHECK ("user_field_value_versions"."previous_revision">=0 and "user_field_value_versions"."revision"="user_field_value_versions"."previous_revision"+1
    and "user_field_value_versions"."custom_field_count" between 0 and 500 and ("user_field_value_versions"."time_zone" is null or ("user_field_value_versions"."custom_field_count">0 and length("user_field_value_versions"."time_zone") between 1 and 100))),
	CONSTRAINT "user_field_value_labels" CHECK (length(trim("user_field_value_versions"."username")) between 1 and 100 and length(trim("user_field_value_versions"."display_name")) between 1 and 200
    and length(trim("user_field_value_versions"."saved_by_username")) between 1 and 100 and length(trim("user_field_value_versions"."saved_by_name")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "user_version_custom_field_values" (
	"organization_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
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
	"user_username" text,
	"user_name" text,
	CONSTRAINT "user_custom_value_pk" PRIMARY KEY("organization_id","subject_user_id","revision","field_id","position"),
	CONSTRAINT "user_custom_value_user_observation" CHECK (("user_version_custom_field_values"."user_id" is null and num_nonnulls("user_version_custom_field_values"."user_username","user_version_custom_field_values"."user_name")=0)
    or ("user_version_custom_field_values"."user_id" is not null and "user_version_custom_field_values"."user_username" is not null and "user_version_custom_field_values"."user_name" is not null
      and length(trim("user_version_custom_field_values"."user_username")) between 1 and 100 and length(trim("user_version_custom_field_values"."user_name")) between 1 and 200)),
	CONSTRAINT "user_custom_value_raw" CHECK ("user_version_custom_field_values"."position" between 0 and 499 and num_nonnulls("user_version_custom_field_values"."raw_text","user_version_custom_field_values"."raw_number","user_version_custom_field_values"."raw_boolean")=1
    and (("user_version_custom_field_values"."raw_kind"='text' and "user_version_custom_field_values"."raw_text" is not null and length("user_version_custom_field_values"."raw_text")<=16000)
      or ("user_version_custom_field_values"."raw_kind"='number' and "user_version_custom_field_values"."raw_number" is not null and "user_version_custom_field_values"."raw_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("user_version_custom_field_values"."raw_kind"='boolean' and "user_version_custom_field_values"."raw_boolean" is not null))),
	CONSTRAINT "user_custom_value_number_text" CHECK (case when "user_version_custom_field_values"."raw_kind"='number' then
    "user_version_custom_field_values"."raw_number_text" is not null and length("user_version_custom_field_values"."raw_number_text") between 1 and 32
    and case when "user_version_custom_field_values"."raw_number_text" ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then "user_version_custom_field_values"."raw_number_text"::double precision="user_version_custom_field_values"."raw_number" else false end
    else "user_version_custom_field_values"."raw_number_text" is null end),
	CONSTRAINT "user_custom_value_interpretation" CHECK ("user_version_custom_field_values"."interpretation_state" in ('empty','valid','invalid','out_of_range')
    and ("user_version_custom_field_values"."parsed_number" is null or "user_version_custom_field_values"."parsed_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
    and ("user_version_custom_field_values"."parsed_timestamp" is null or isfinite("user_version_custom_field_values"."parsed_timestamp")) and ("user_version_custom_field_values"."parsed_date" is null or isfinite("user_version_custom_field_values"."parsed_date"))
    and (("user_version_custom_field_values"."option_id" is null and "user_version_custom_field_values"."option_revision" is null) or ("user_version_custom_field_values"."option_id" is not null and "user_version_custom_field_values"."option_revision" is not null and "user_version_custom_field_values"."option_revision">0))
    and ("user_version_custom_field_values"."interpretation_state"='valid' or num_nonnulls("user_version_custom_field_values"."parsed_number","user_version_custom_field_values"."parsed_boolean","user_version_custom_field_values"."parsed_date","user_version_custom_field_values"."parsed_timestamp","user_version_custom_field_values"."option_id","user_version_custom_field_values"."option_revision","user_version_custom_field_values"."user_id","user_version_custom_field_values"."attachment_id")=0)
    and (("user_version_custom_field_values"."interpretation_state"='empty')=("user_version_custom_field_values"."raw_kind"='text' and "user_version_custom_field_values"."raw_text"='')))
);
--> statement-breakpoint
CREATE TABLE "user_version_custom_fields" (
	"organization_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
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
	CONSTRAINT "user_custom_field_pk" PRIMARY KEY("organization_id","subject_user_id","revision","field_id"),
	CONSTRAINT "user_custom_field_position" UNIQUE("organization_id","subject_user_id","revision","position"),
	CONSTRAINT "user_custom_field_shape" CHECK ("user_version_custom_fields"."position" between 0 and 499 and "user_version_custom_fields"."value_count" between 0 and 500
    and ("user_version_custom_fields"."is_array" or "user_version_custom_fields"."value_count"=1)
    and "user_version_custom_fields"."field_type" in ('text','number','date','select','lookup','longtext','attachment','multi_user_select','date_time','checkbox','email')),
	CONSTRAINT "user_custom_field_display" CHECK (num_nonnulls("user_version_custom_fields"."display_text","user_version_custom_fields"."display_number","user_version_custom_fields"."display_boolean")=1
    and (("user_version_custom_fields"."display_kind"='text' and "user_version_custom_fields"."display_text" is not null and length("user_version_custom_fields"."display_text")<=8000998)
      or ("user_version_custom_fields"."display_kind"='number' and "user_version_custom_fields"."display_number" is not null and "user_version_custom_fields"."display_number" between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or ("user_version_custom_fields"."display_kind"='boolean' and "user_version_custom_fields"."display_boolean" is not null))
    and (not "user_version_custom_fields"."is_array" or "user_version_custom_fields"."display_kind"='text')),
	CONSTRAINT "user_custom_field_zone" CHECK (("user_version_custom_fields"."field_type" in ('date','date_time') and "user_version_custom_fields"."time_zone" is not null
      and length("user_version_custom_fields"."time_zone") between 1 and 100 and "user_version_custom_fields"."time_zone_data_version" is not null and length("user_version_custom_fields"."time_zone_data_version") between 1 and 40
      and "user_version_custom_fields"."date_parser_version" is not null and length("user_version_custom_fields"."date_parser_version") between 1 and 80)
    or ("user_version_custom_fields"."field_type" not in ('date','date_time') and num_nonnulls("user_version_custom_fields"."time_zone","user_version_custom_fields"."time_zone_data_version","user_version_custom_fields"."date_parser_version")=0))
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "custom_field_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_field_value_versions" ADD CONSTRAINT "user_field_value_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_field_value_versions" ADD CONSTRAINT "user_field_value_subject_fk" FOREIGN KEY ("organization_id","subject_user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_field_value_versions" ADD CONSTRAINT "user_field_value_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_version_custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_field_fk" FOREIGN KEY ("organization_id","subject_user_id","revision","field_id") REFERENCES "public"."user_version_custom_fields"("organization_id","subject_user_id","revision","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_option_fk" FOREIGN KEY ("organization_id","field_id","option_revision","option_id") REFERENCES "public"."custom_field_version_options"("organization_id","field_id","revision","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_field_values" ADD CONSTRAINT "user_custom_value_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "public"."custom_field_attachments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_fields" ADD CONSTRAINT "user_version_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_fields" ADD CONSTRAINT "user_custom_field_version_fk" FOREIGN KEY ("organization_id","subject_user_id","revision") REFERENCES "public"."user_field_value_versions"("organization_id","subject_user_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_version_custom_fields" ADD CONSTRAINT "user_custom_field_definition_fk" FOREIGN KEY ("organization_id","field_id","field_revision") REFERENCES "public"."custom_field_versions"("organization_id","field_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_custom_value_raw_search" ON "user_version_custom_field_values" USING btree ("organization_id","field_id",md5("raw_text"),"subject_user_id","revision") WHERE "user_version_custom_field_values"."raw_text" is not null;--> statement-breakpoint
CREATE INDEX "user_custom_field_definition" ON "user_version_custom_fields" USING btree ("organization_id","field_id","subject_user_id","revision");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "membership_custom_field_revision" CHECK ("memberships"."custom_field_revision">=0);
--> statement-breakpoint
CREATE FUNCTION users_assert_custom_fields(target_organization uuid,target_user uuid,target_revision integer,check_definition_set boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.user_field_value_versions; field_count integer; minimum_position integer; maximum_position integer; item_count integer;
BEGIN
  SELECT * INTO version FROM public.user_field_value_versions
    WHERE organization_id=target_organization AND subject_user_id=target_user AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'User Custom Field history is missing' USING ERRCODE='23514',CONSTRAINT='user_custom_field_complete'; END IF;
  SELECT count(*),min(position),max(position),coalesce(sum(value_count),0) INTO field_count,minimum_position,maximum_position,item_count
    FROM public.user_version_custom_fields
    WHERE organization_id=target_organization AND subject_user_id=target_user AND revision=target_revision;
  IF field_count<>version.custom_field_count OR item_count>5000
    OR (field_count>0 AND (minimum_position<>0 OR maximum_position<>field_count-1)) THEN
    RAISE EXCEPTION 'User Custom Fields require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='user_custom_field_complete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_version_custom_fields field LEFT JOIN LATERAL (
      SELECT count(*) AS count,min(position) AS minimum,max(position) AS maximum
      FROM public.user_version_custom_field_values value
      WHERE value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
        AND value.revision=field.revision AND value.field_id=field.field_id
    ) items ON true
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision
      AND (items.count<>field.value_count OR (items.count>0 AND (items.minimum<>0 OR items.maximum<>items.count-1)))
  ) THEN RAISE EXCEPTION 'User Custom Field items require a complete ordered version' USING ERRCODE='23514',CONSTRAINT='user_custom_value_complete'; END IF;
    IF check_definition_set AND (EXISTS (
      SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='users'
      EXCEPT SELECT field_id,field_revision FROM public.user_version_custom_fields
        WHERE organization_id=target_organization AND subject_user_id=target_user AND revision=target_revision
    ) OR EXISTS (
      SELECT field_id,field_revision FROM public.user_version_custom_fields
        WHERE organization_id=target_organization AND subject_user_id=target_user AND revision=target_revision
      EXCEPT SELECT id,revision FROM public.custom_field_definitions WHERE organization_id=target_organization AND active AND associated_with='users'
    )) THEN RAISE EXCEPTION 'User Custom Field definitions changed' USING ERRCODE='23514',CONSTRAINT='user_custom_field_definition_set'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
        ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
      WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision AND definition.is_required
      AND NOT (
        (field.is_array AND definition.field_type<>'multi_user_select'
          AND (NOT definition.allows_multiple OR definition.field_type='attachment'))
        OR EXISTS (
        SELECT 1 FROM public.user_version_custom_field_values value
        WHERE value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id AND value.revision=field.revision AND value.field_id=field.field_id
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
    ) THEN RAISE EXCEPTION 'A required User Custom Field is empty' USING ERRCODE='23514',CONSTRAINT='user_custom_field_required'; END IF;
  IF (version.time_zone IS NOT NULL) IS DISTINCT FROM EXISTS (
    SELECT 1 FROM public.user_version_custom_fields WHERE organization_id=target_organization AND subject_user_id=target_user
      AND revision=target_revision AND field_type IN ('date','date_time')
  ) THEN RAISE EXCEPTION 'Capture time zone requires its date fields' USING ERRCODE='23514',CONSTRAINT='user_custom_field_timezone'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION users_assert_custom_field_uniqueness(target_organization uuid,target_user uuid,target_revision integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (
    SELECT field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision AND definition.validate_uniqueness
      AND public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) IS NOT NULL
    GROUP BY field.field_id,public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text)
    HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'A unique Custom Field contains duplicate values' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_version_custom_fields field JOIN public.custom_field_versions definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    JOIN public.user_version_custom_field_values value ON value.organization_id=field.organization_id AND value.subject_user_id=field.subject_user_id
      AND value.revision=field.revision AND value.field_id=field.field_id
    CROSS JOIN LATERAL (SELECT public.masters_product_custom_field_unique_text(field.is_array,value.raw_kind,value.raw_text,value.raw_number,value.raw_boolean,value.raw_number_text) AS text) incoming
    JOIN public.user_version_custom_field_values existing ON existing.organization_id=field.organization_id AND existing.field_id=field.field_id
      AND existing.raw_text IS NOT NULL AND md5(existing.raw_text)=md5(incoming.text) AND existing.raw_text=incoming.text
    JOIN public.memberships member ON member.organization_id=existing.organization_id AND member.user_id=existing.subject_user_id AND member.custom_field_revision=existing.revision
    WHERE field.organization_id=target_organization AND field.subject_user_id=target_user AND field.revision=target_revision
      AND definition.validate_uniqueness AND incoming.text IS NOT NULL AND existing.subject_user_id<>target_user
  ) THEN RAISE EXCEPTION 'A unique Custom Field value is already in use' USING ERRCODE='23514',CONSTRAINT='user_custom_field_unique'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION users_guard_custom_field_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.user_field_value_versions; field public.user_version_custom_fields; definition public.custom_field_versions;
  related_count integer;
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
          ) THEN RAISE EXCEPTION 'A selection requires its exact field option' USING ERRCODE='23514',CONSTRAINT='user_custom_value_option'; END IF;
          IF NEW.option_revision<>field.field_revision AND NOT EXISTS (
            SELECT 1 FROM public.user_version_custom_field_values previous
            WHERE previous.organization_id=NEW.organization_id AND previous.subject_user_id=NEW.subject_user_id AND previous.revision=version.previous_revision
              AND previous.field_id=NEW.field_id AND previous.option_id=NEW.option_id AND previous.option_revision=NEW.option_revision
              AND (previous.raw_kind,previous.raw_text,previous.raw_number,previous.raw_boolean)
                IS NOT DISTINCT FROM (NEW.raw_kind,NEW.raw_text,NEW.raw_number,NEW.raw_boolean)
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
              WHERE attachment.organization_id=NEW.organization_id AND attachment.id=NEW.attachment_id AND attachment.field_id=NEW.field_id
                AND uploaded_definition.associated_with='users' AND uploaded_definition.field_type='attachment' 
          ) THEN RAISE EXCEPTION 'An attachment must belong to its Custom Field' USING ERRCODE='23514',CONSTRAINT='user_custom_value_attachment'; END IF;
        WHEN 'lookup' THEN RAISE EXCEPTION 'This lookup has no configured source' USING ERRCODE='23514',CONSTRAINT='user_custom_value_lookup';
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
CREATE FUNCTION users_guard_custom_field_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.custom_field_revision<>0 THEN RAISE EXCEPTION 'New memberships have no invented field captures' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.custom_field_revision=OLD.custom_field_revision THEN RETURN NEW; END IF;
  IF (NEW.organization_id,NEW.user_id) IS DISTINCT FROM (OLD.organization_id,OLD.user_id)
    OR OLD.custom_field_revision=2147483647 OR NEW.custom_field_revision<>OLD.custom_field_revision+1 THEN
    RAISE EXCEPTION 'A field capture requires its next membership revision' USING ERRCODE='23514';
  END IF;
  PERFORM public.users_require_manager();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Field capture belongs to another organization' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_custom_field_head_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION users_guard_custom_field_head();
--> statement-breakpoint
CREATE FUNCTION users_guard_custom_field_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'User field capture history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.saved_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.saved_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.memberships member JOIN public.users person ON person.id=member.user_id JOIN public.users editor ON editor.id=NEW.saved_by
      WHERE member.organization_id=NEW.organization_id AND member.user_id=NEW.subject_user_id AND member.custom_field_revision=NEW.revision
        AND (NEW.username,NEW.display_name,NEW.saved_by_username,NEW.saved_by_name)
          IS NOT DISTINCT FROM (person.username,person.display_name,editor.username,editor.display_name)
    ) OR (NEW.previous_revision>0 AND NOT EXISTS (
      SELECT 1 FROM public.user_field_value_versions WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.subject_user_id AND revision=NEW.previous_revision
    )) THEN RAISE EXCEPTION 'A user capture requires its actual subject, editor and version transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_custom_field_version_guard BEFORE INSERT OR UPDATE OR DELETE ON user_field_value_versions FOR EACH ROW EXECUTE FUNCTION users_guard_custom_field_version();
--> statement-breakpoint
CREATE FUNCTION users_begin_field_capture(target uuid,expected_revision integer,requested_id uuid,requested_count integer,requested_zone text)
RETURNS TABLE(saved_revision integer,replayed boolean,previous_field_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid; prior public.user_field_value_versions;
  head_revision integer; old_count integer:=0; definition_count integer;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR requested_id IS NULL
    OR requested_count IS NULL OR requested_count NOT BETWEEN 0 AND 500
    OR (requested_zone IS NOT NULL AND (requested_count=0 OR length(requested_zone) NOT BETWEEN 1 AND 100)) THEN
    RAISE EXCEPTION 'Invalid user field capture' USING ERRCODE='23514',CONSTRAINT='user_custom_field_invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,target]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,target]) ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.user_field_value_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.subject_user_id,prior.saved_by,prior.previous_revision,prior.custom_field_count,prior.time_zone)
      IS DISTINCT FROM (target,actor,expected_revision,requested_count,requested_zone) THEN
      RAISE EXCEPTION 'Save request already used for another capture' USING ERRCODE='23514',CONSTRAINT='user_custom_field_request_reused';
    END IF;
    -- The service compares the complete immutable raw values before accepting a replay.
    RETURN QUERY SELECT prior.revision,true,NULL::integer; RETURN;
  END IF;
  SELECT custom_field_revision INTO head_revision FROM public.memberships WHERE organization_id=org AND user_id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found'; END IF;
  IF head_revision<>expected_revision THEN
    RAISE EXCEPTION 'User fields changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='user_custom_field_stale';
  END IF;
  IF head_revision>0 THEN
    SELECT custom_field_count INTO old_count FROM public.user_field_value_versions WHERE organization_id=org AND subject_user_id=target AND revision=head_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'User field history is missing' USING ERRCODE='23514',CONSTRAINT='user_custom_field_complete'; END IF;
    PERFORM public.users_assert_custom_fields(org,target,head_revision);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
  actor:=public.users_require_manager();
  SELECT count(*) INTO definition_count FROM public.custom_field_definitions WHERE organization_id=org AND active AND associated_with='users';
  IF definition_count>500 THEN RAISE EXCEPTION 'This form supports at most 500 Custom Fields' USING ERRCODE='23514',CONSTRAINT='user_custom_field_limit'; END IF;
  IF definition_count<>requested_count THEN
    RAISE EXCEPTION 'Provide the current user Custom Fields' USING ERRCODE='23514',CONSTRAINT='user_custom_field_definition_set';
  END IF;
  UPDATE public.memberships SET custom_field_revision=expected_revision+1 WHERE organization_id=org AND user_id=target;
  INSERT INTO public.user_field_value_versions(organization_id,subject_user_id,revision,previous_revision,request_id,custom_field_count,time_zone,
    username,display_name,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,expected_revision,requested_id,requested_count,requested_zone,person.username,person.display_name,
      actor,editor.username,editor.display_name FROM public.users person JOIN public.users editor ON editor.id=actor WHERE person.id=target;
  RETURN QUERY SELECT expected_revision+1,false,old_count;
END $$;
REVOKE ALL ON FUNCTION users_begin_field_capture(uuid,integer,uuid,integer,text) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_begin_field_capture(uuid,integer,uuid,integer,text) TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION users_require_custom_field_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.custom_field_revision IS DISTINCT FROM OLD.custom_field_revision AND NOT EXISTS (
    SELECT 1 FROM public.user_field_value_versions WHERE organization_id=NEW.organization_id AND subject_user_id=NEW.user_id
      AND revision=NEW.custom_field_revision AND previous_revision=OLD.custom_field_revision AND created_transaction_id=pg_current_xact_id()
  ) THEN RAISE EXCEPTION 'Membership fields require their actual capture event' USING ERRCODE='23514',CONSTRAINT='user_custom_field_complete'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER membership_custom_field_version_required AFTER UPDATE ON memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_require_custom_field_version();
CREATE FUNCTION users_check_custom_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.users_assert_custom_fields(NEW.organization_id,NEW.subject_user_id,NEW.revision,true);
  PERFORM public.users_assert_custom_field_uniqueness(NEW.organization_id,NEW.subject_user_id,NEW.revision);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER user_custom_fields_complete AFTER INSERT ON user_field_value_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_check_custom_fields();
--> statement-breakpoint
ALTER TABLE user_field_value_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_field_value_versions FROM PUBLIC,sampleify_app,sampleify_report_worker;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['user_version_custom_fields','user_version_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_app,sampleify_report_worker',relation);
    EXECUTE format('CREATE POLICY user_custom_field_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=(SELECT public.users_directory_organization()))',relation);
    EXECUTE format('CREATE POLICY user_custom_field_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id=(SELECT public.users_directory_organization()) AND (SELECT public.app_has_permission(''users.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER user_custom_field_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION users_guard_custom_field_history()',relation);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION users_assert_custom_fields(uuid,uuid,integer,boolean),users_assert_custom_field_uniqueness(uuid,uuid,integer),
  users_guard_custom_field_history(),users_guard_custom_field_head(),users_guard_custom_field_version(),users_require_custom_field_version(),users_check_custom_fields()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE VIEW user_field_capture_heads WITH (security_barrier=true,security_invoker=false) AS
  SELECT member.organization_id,member.user_id AS subject_user_id,member.custom_field_revision AS revision
  FROM public.memberships member WHERE member.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_field_capture_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,subject_user_id,revision,previous_revision,custom_field_count,time_zone,username,display_name,
    saved_by,saved_by_username,saved_by_name,saved_at
  FROM public.user_field_value_versions WHERE organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON user_field_capture_heads,user_field_capture_history FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON user_field_capture_heads,user_field_capture_history TO sampleify_app;
