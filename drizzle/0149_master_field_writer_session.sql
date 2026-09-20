-- Revalidate actual Product/Parameter writers after the definition mutex and before any saved retry or mutation.
CREATE FUNCTION masters_lock_field_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
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
    RAISE EXCEPTION 'Active master management session required' USING ERRCODE='42501',CONSTRAINT='master_field_session_required';
  END IF;
  RETURN actor;
END $$;
REVOKE ALL ON FUNCTION masters_lock_field_writer() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_lock_field_writer() TO sampleify_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_guard_product_custom_field_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_count integer; unique_field uuid;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  PERFORM public.masters_lock_field_writer();
  FOR unique_field IN SELECT id FROM public.custom_field_definitions
    WHERE organization_id=NEW.organization_id AND associated_with='product' AND active AND validate_uniqueness ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('product-custom-field-unique:'||NEW.organization_id::text||':'||unique_field::text,0));
  END LOOP;
  IF TG_OP='UPDATE' AND EXISTS (
    SELECT 1 FROM public.product_versions WHERE organization_id=OLD.organization_id AND product_id=OLD.id AND revision=OLD.revision
  ) THEN PERFORM public.masters_assert_product_custom_fields(OLD.organization_id,OLD.id,OLD.revision); END IF;
  IF NOT NEW.active AND NEW.custom_fields_provided THEN
    RAISE EXCEPTION 'Product retirement preserves Custom Fields' USING ERRCODE='23514',CONSTRAINT='product_custom_field_preserve';
  END IF;
  IF NEW.custom_fields_provided THEN
    SELECT count(*) INTO expected_count FROM public.custom_field_definitions
      WHERE organization_id=NEW.organization_id AND associated_with='product' AND active;
    IF expected_count<>NEW.custom_field_count THEN
      RAISE EXCEPTION 'Provide the current Product Custom Fields' USING ERRCODE='23514',CONSTRAINT='product_custom_field_definition_set';
    END IF;
  ELSE
    expected_count := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.custom_field_count END;
    IF NEW.custom_field_count<>expected_count OR (NEW.active AND EXISTS (
      SELECT 1 FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND associated_with='product' AND active
    )) THEN RAISE EXCEPTION 'Product Custom Field omission requires no current definitions' USING ERRCODE='23514',CONSTRAINT='product_custom_field_preserve'; END IF;
  END IF;
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
