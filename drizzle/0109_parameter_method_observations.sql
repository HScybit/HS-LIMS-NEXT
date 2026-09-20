ALTER TABLE "test_parameter_version_methods" ADD COLUMN "method_revision" integer;--> statement-breakpoint
ALTER TABLE "test_parameter_version_methods" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "test_parameter_version_methods" ADD CONSTRAINT "test_parameter_version_method_observation" CHECK (("test_parameter_version_methods"."method_revision" is null and "test_parameter_version_methods"."method_name" is null)
    or ("test_parameter_version_methods"."method_revision" is not null and "test_parameter_version_methods"."method_name" is not null and "test_parameter_version_methods"."method_revision">0 and length(trim("test_parameter_version_methods"."method_name")) between 1 and 250));
--> statement-breakpoint
-- Observe each applicable method head at the actual parameter save. Old unknown
-- pairs remain NULL; this does not invent missing method-version history.
CREATE OR REPLACE FUNCTION masters_track_test_parameter() RETURNS trigger
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
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New parameters start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at,NEW.code) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at,OLD.code)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Parameter writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND (NEW.name,NEW.description,NEW.master_key,NEW.scheme_abbreviation,NEW.display_order,NEW.laboratory_id,NEW.measurement_unit_id,NEW.default_scale,NEW.uncertainty_configured)
      IS DISTINCT FROM (OLD.name,OLD.description,OLD.master_key,OLD.scheme_abbreviation,OLD.display_order,OLD.laboratory_id,OLD.measurement_unit_id,OLD.default_scale,OLD.uncertainty_configured) THEN
      RAISE EXCEPTION 'Parameter retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.test_parameter_versions(organization_id,parameter_id,revision,request_id,previous_revision,operation,
    code,name,description,master_key,scheme_abbreviation,display_order,active,laboratory_id,measurement_unit_id,default_scale,has_uncertainty,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.description,NEW.master_key,NEW.scheme_abbreviation,NEW.display_order,NEW.active,NEW.laboratory_id,NEW.measurement_unit_id,NEW.default_scale,NEW.uncertainty_configured,actor);
  INSERT INTO public.test_parameter_version_methods(organization_id,parameter_id,revision,method_id,is_default,method_revision,method_name)
    SELECT NEW.organization_id,NEW.id,NEW.revision,link.method_id,link.is_default,method.revision,method.name
    FROM public.parameter_methods link
    JOIN public.methods_of_analysis method ON method.organization_id=link.organization_id AND method.id=link.method_id
    WHERE link.organization_id=NEW.organization_id AND link.test_parameter_id=NEW.id;
  RETURN NEW;
END $$;
