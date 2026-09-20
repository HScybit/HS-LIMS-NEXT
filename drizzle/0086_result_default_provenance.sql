ALTER TABLE "template_fields" ADD COLUMN "default_lexical" text;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_default_lexical" CHECK ("template_fields"."default_lexical" is null or ("template_fields"."widget" = 'result_widget' and "template_fields"."default_state" = 'present' and "template_fields"."default_number" is not null and length("template_fields"."default_lexical") between 1 and 1000
    and case when "template_fields"."default_lexical" ~ '^-?[0-9]+([.][0-9]+)?$' then "template_fields"."default_number" = "template_fields"."default_lexical"::numeric else false end));
--> statement-breakpoint
-- Bind newly initialized defaults to the exact authored version. No old value or actor is rewritten.
CREATE OR REPLACE FUNCTION template_guard_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE capture public.template_instances; occurrence public.template_occurrences; field public.template_fields;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Saved values are append-only' USING ERRCODE = '55000'; END IF;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id = NEW.organization_id AND id = NEW.instance_id FOR UPDATE;
  IF capture.status IS DISTINCT FROM 'editing' OR capture.version_id <> NEW.version_id OR capture.revision <> NEW.revision THEN
    RAISE EXCEPTION 'Value must use the editable capture version and current revision' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO occurrence FROM public.template_occurrences WHERE organization_id = NEW.organization_id AND instance_id = NEW.instance_id AND version_id = NEW.version_id AND id = NEW.occurrence_id;
  SELECT * INTO field FROM public.template_fields WHERE organization_id = NEW.organization_id AND version_id = NEW.version_id AND id = NEW.field_id;
  IF occurrence.id IS NULL OR field.id IS NULL OR occurrence.removed_revision IS NOT NULL OR field.repeat_group_id IS DISTINCT FROM occurrence.group_id THEN
    RAISE EXCEPTION 'Value field and repeat occurrence do not match' USING ERRCODE = '23514';
  END IF;
  IF (field.widget = 'formula_widget') IS DISTINCT FROM (NEW.origin = 'calculated') THEN
    RAISE EXCEPTION 'Calculated fields cannot accept entered values' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin='default' AND (field.default_state='absent' OR occurrence.created_revision<>NEW.revision
    OR (NEW.state,NEW.number_value,NEW.text_value,NEW.boolean_value,NEW.date_value,NEW.option_id,NEW.lexical,NEW.error_code,NEW.error_message)
      IS DISTINCT FROM (field.default_state,field.default_number,field.default_text,field.default_boolean,field.default_date,NULL::uuid,field.default_lexical,NULL::text,NULL::text)) THEN
    RAISE EXCEPTION 'Default history must match its frozen field and new occurrence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
