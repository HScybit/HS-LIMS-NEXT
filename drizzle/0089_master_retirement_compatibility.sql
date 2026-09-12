ALTER TABLE "test_parameter_versions" DROP CONSTRAINT "test_parameter_version_fields";--> statement-breakpoint
ALTER TABLE "method_versions" DROP CONSTRAINT "method_version_fields";--> statement-breakpoint
ALTER TABLE "test_parameter_versions" ADD CONSTRAINT "test_parameter_version_fields" CHECK (length(trim("test_parameter_versions"."name")) between 1 and 250
    and ("test_parameter_versions"."operation"='retire' or (length(trim("test_parameter_versions"."name"))<=200 and length("test_parameter_versions"."description")<=16000))
    and length(trim("test_parameter_versions"."code")) between 1 and 64 and length(trim("test_parameter_versions"."master_key")) between 1 and 64
    and length(trim("test_parameter_versions"."scheme_abbreviation")) between 1 and 64 and "test_parameter_versions"."display_order">=0 and "test_parameter_versions"."default_scale" between 0 and 12
    and ("test_parameter_versions"."operation"<>'retire' or not "test_parameter_versions"."active"));--> statement-breakpoint
ALTER TABLE "method_versions" ADD CONSTRAINT "method_version_fields" CHECK (length(trim("method_versions"."name")) between 1 and 250
    and ("method_versions"."operation"='retire' or (length(trim("method_versions"."name"))<=200 and length("method_versions"."description")<=16000))
    and length(trim("method_versions"."code")) between 1 and 64 and length(trim("method_versions"."method_uuid")) between 1 and 100
    and "method_versions"."decimal_scale" between 0 and 12 and "method_versions"."access_user_count" between 0 and 500
    and ("method_versions"."operation"<>'retire' or not "method_versions"."active"));
--> statement-breakpoint
-- Retire existing text unchanged; enforce new-write rules without rewriting prior history.
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
  INSERT INTO public.test_parameter_version_methods(organization_id,parameter_id,revision,method_id,is_default)
    SELECT NEW.organization_id,NEW.id,NEW.revision,method_id,is_default FROM public.parameter_methods
    WHERE organization_id=NEW.organization_id AND test_parameter_id=NEW.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_track_method() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Existing migration/fixture records do not acquire fabricated past actors.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Method writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New methods start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at,NEW.code) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at,OLD.code)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Method writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND (NEW.method_uuid,NEW.name,NEW.description,NEW.decimal_scale,NEW.parse_number,NEW.access_user_count)
      IS DISTINCT FROM (OLD.method_uuid,OLD.name,OLD.description,OLD.decimal_scale,OLD.parse_number,OLD.access_user_count) THEN
      RAISE EXCEPTION 'Method retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.method_versions(organization_id,method_id,revision,request_id,previous_revision,operation,code,method_uuid,name,description,
    decimal_scale,parse_number,active,access_user_count,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.method_uuid,NEW.name,NEW.description,NEW.decimal_scale,NEW.parse_number,NEW.active,NEW.access_user_count,actor);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_check_parameter_grid() RETURNS trigger
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
  IF NEW.operation='retire' AND (EXISTS (
    WITH prior AS (SELECT id,position,title FROM public.parameter_uncertainty_columns WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision),
      current AS (SELECT id,position,title FROM public.parameter_uncertainty_columns WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision)
    SELECT 1 FROM prior FULL JOIN current USING(id) WHERE (prior.position,prior.title) IS DISTINCT FROM (current.position,current.title)
  ) OR EXISTS (
    WITH prior AS (SELECT id,position FROM public.parameter_uncertainty_rows WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision),
      current AS (SELECT id,position FROM public.parameter_uncertainty_rows WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision)
    SELECT 1 FROM prior FULL JOIN current USING(id) WHERE prior.position IS DISTINCT FROM current.position
  ) OR EXISTS (
    WITH prior AS (SELECT row_id,column_id,text_value FROM public.parameter_uncertainty_cells WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.previous_revision),
      current AS (SELECT row_id,column_id,text_value FROM public.parameter_uncertainty_cells WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.revision)
    SELECT 1 FROM prior FULL JOIN current USING(row_id,column_id) WHERE prior.text_value IS DISTINCT FROM current.text_value
  )) THEN
    RAISE EXCEPTION 'Parameter retirement preserves its last uncertainty grid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
