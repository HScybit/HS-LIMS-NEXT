-- Bulk Product updates reactivate a retired match. Parameter and Method bulk
-- updates retain its inactive status. Ordinary retirement still preserves values.

--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_track_product() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Existing migration/fixture records gain history only on an actual app edit.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Product writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New products start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR (NOT OLD.active AND (NOT NEW.active OR NOT EXISTS (
        SELECT 1 FROM public.master_bulk_reviews review
        JOIN public.master_bulk_batches batch ON batch.organization_id=review.organization_id AND batch.id=review.batch_id
        JOIN public.master_bulk_rows row ON row.organization_id=review.organization_id AND row.batch_id=review.batch_id AND row.id=review.row_id AND row.revision=review.input_revision
        WHERE review.organization_id=NEW.organization_id AND review.id=NEW.save_request_id AND review.valid
          AND review.candidate_id=NEW.id AND review.expected_revision=OLD.revision AND review.operation='reactivate' AND batch.resource='products'
      ))) THEN
      RAISE EXCEPTION 'Product writes preserve identity and advance the revision without an unsupported status change' USING ERRCODE='23514';
    END IF;
    -- Check an earlier save before a second edit can replace its operational links.
    IF EXISTS (SELECT 1 FROM public.product_versions WHERE organization_id=OLD.organization_id AND product_id=OLD.id AND revision=OLD.revision) THEN
      PERFORM public.masters_assert_product_tags(OLD.organization_id,OLD.id,OLD.revision,true);
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND ((NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.job_template_id)
      IS DISTINCT FROM (OLD.code,OLD.name,OLD.description,OLD.abbreviation,OLD.job_template_id)
      OR NEW.tag_count<>(SELECT count(*) FROM public.product_tags WHERE organization_id=NEW.organization_id AND product_id=NEW.id)) THEN
      RAISE EXCEPTION 'Product retirement preserves its last settings and tags' USING ERRCODE='23514';
    END IF;
  END IF;
  IF operation<>'retire' AND NEW.job_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.templates template WHERE template.organization_id=NEW.organization_id AND template.id=NEW.job_template_id AND template.active
      AND EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND template_id=NEW.job_template_id AND status<>'building') FOR SHARE OF template;
    IF NOT FOUND THEN RAISE EXCEPTION 'Select an active template in this organization' USING ERRCODE='23514',CONSTRAINT='product_active_template'; END IF;
  END IF;
  INSERT INTO public.product_versions(organization_id,product_id,revision,request_id,previous_revision,operation,code,name,description,abbreviation,
    job_template_id,active,tag_count,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.job_template_id,NEW.active,NEW.tag_count,actor);
  INSERT INTO public.product_version_sample_categories(organization_id,product_id,revision,sample_category_id)
    SELECT NEW.organization_id,NEW.id,NEW.revision,sample_category_id FROM public.product_sample_categories
    WHERE organization_id=NEW.organization_id AND product_id=NEW.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
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
      OR NEW.revision<>OLD.revision+1 OR (NOT OLD.active AND (NEW.active OR NOT EXISTS (
        SELECT 1 FROM public.master_bulk_reviews review
        JOIN public.master_bulk_batches batch ON batch.organization_id=review.organization_id AND batch.id=review.batch_id
        JOIN public.master_bulk_rows row ON row.organization_id=review.organization_id AND row.batch_id=review.batch_id AND row.id=review.row_id AND row.revision=review.input_revision
        WHERE review.organization_id=NEW.organization_id AND review.id=NEW.save_request_id AND review.valid
          AND review.candidate_id=NEW.id AND review.expected_revision=OLD.revision AND review.operation='update_retired' AND batch.resource='test-parameters'
      ))) THEN
      RAISE EXCEPTION 'Parameter writes preserve identity and advance the revision without an unsupported status change' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN OLD.active AND NOT NEW.active THEN 'retire' ELSE 'update' END;
    IF OLD.active AND NOT NEW.active AND (NEW.name,NEW.description,NEW.master_key,NEW.scheme_abbreviation,NEW.display_order,NEW.laboratory_id,NEW.measurement_unit_id,NEW.default_scale,NEW.uncertainty_configured)
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
      OR NEW.revision<>OLD.revision+1 OR (NOT OLD.active AND (NEW.active OR NOT EXISTS (
        SELECT 1 FROM public.master_bulk_reviews review
        JOIN public.master_bulk_batches batch ON batch.organization_id=review.organization_id AND batch.id=review.batch_id
        JOIN public.master_bulk_rows row ON row.organization_id=review.organization_id AND row.batch_id=review.batch_id AND row.id=review.row_id AND row.revision=review.input_revision
        WHERE review.organization_id=NEW.organization_id AND review.id=NEW.save_request_id AND review.valid
          AND review.candidate_id=NEW.id AND review.expected_revision=OLD.revision AND review.operation='update_retired' AND batch.resource='methods'
      ))) THEN
      RAISE EXCEPTION 'Method writes preserve identity and advance the revision without an unsupported status change' USING ERRCODE='23514';
    END IF;
    operation := CASE WHEN OLD.active AND NOT NEW.active THEN 'retire' ELSE 'update' END;
    IF OLD.active AND NOT NEW.active AND (NEW.method_uuid,NEW.name,NEW.description,NEW.decimal_scale,NEW.parse_number,NEW.access_user_count)
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
CREATE OR REPLACE FUNCTION masters_guard_parameter_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer; unique_field uuid;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  PERFORM public.masters_lock_field_writer();
  FOR unique_field IN SELECT id FROM public.custom_field_definitions
    WHERE organization_id=NEW.organization_id AND associated_with='parameter' AND active AND validate_uniqueness ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('parameter-custom-field-unique:'||NEW.organization_id::text||':'||unique_field::text,0));
  END LOOP;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.test_parameter_versions WHERE organization_id=OLD.organization_id AND parameter_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_parameter_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF TG_OP='UPDATE' AND OLD.active AND NOT NEW.active AND NEW.custom_fields_provided THEN
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_guard_method_custom_field_change() RETURNS trigger
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
  IF TG_OP='UPDATE' AND OLD.active AND NOT NEW.active AND NEW.custom_fields_provided THEN
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
