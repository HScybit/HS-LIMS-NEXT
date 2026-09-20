-- Instrument service types (Preventive Maintenance, Breakdown, Calibration) are no longer
-- an organization-configurable list; they are a fixed set of three. Removes the whole
-- org-settings-authored catalog (organization_instrument_service_entries/_versions, the
-- instrument_service_type_catalog view and organization_save_instrument_services) and
-- switches instrument_version_services.service_code (per-instrument schedule configs) and
-- instrument_service_logs.service_code (generic service history log entries; breakdown
-- events keep going through their own instrument_breakdown_logs table) to fixed CHECK
-- constraints instead of a per-org FK/lookup.
DROP VIEW instrument_service_type_catalog;
--> statement-breakpoint
ALTER TABLE instrument_version_services DROP CONSTRAINT instrument_service_definition_fk;
ALTER TABLE instrument_version_services DROP COLUMN service_definition_id;
ALTER TABLE instrument_version_services DROP COLUMN service_definition_revision;
ALTER TABLE instrument_version_services ADD CONSTRAINT instrument_version_service_code_values
  CHECK (service_code = ANY (ARRAY['preventive_maintenance','breakdown','calibration']));
--> statement-breakpoint
ALTER TABLE instrument_service_logs ADD CONSTRAINT instrument_service_log_code_values
  CHECK (service_code = ANY (ARRAY['preventive_maintenance','calibration']));
--> statement-breakpoint
DROP FUNCTION organization_save_instrument_services(integer,uuid[],text[],text[],boolean[]);
DROP TABLE organization_instrument_service_entries;
DROP TABLE organization_instrument_service_versions;
DROP FUNCTION organization_guard_instrument_service_history();
--> statement-breakpoint
CREATE FUNCTION instrument_service_type_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['preventive_maintenance','breakdown','calibration'] $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.instruments_save(target_id uuid, expected_revision integer, requested_id uuid, fingerprint text, p_code text, p_name text, p_description text, p_laboratory_id uuid, p_make text, p_model_name text, p_serial_number text, p_date_of_installation date, p_calibration_agency text, p_calibrated boolean, p_cost_of_equipment numeric, p_purchase_file_id uuid, p_current_location text, p_manufacturer_supplier text, p_active boolean, p_user_ids uuid[], p_services_provided boolean, p_service_ids uuid[], p_service_codes text[], p_template_ids uuid[], p_workflow_ids uuid[], p_reminder_before integer[], p_frequency integer[], p_last_performed date[], p_reminder_frequency integer[], p_next_reminder date[], p_service_active boolean[], p_role_service_ids uuid[], p_role_ids uuid[], p_custom_field_count integer, p_custom_fields_provided boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE org uuid:=public.organization_module_scope(); prior integer; head public.instruments; old_version public.instrument_versions;
  next_revision integer:=expected_revision+1; service_count integer:=cardinality(p_service_ids); user_count integer;
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
  -- Template type changes lock their parent below; hold that parent until capture.
  PERFORM 1 FROM public.templates WHERE organization_id=org AND id=ANY(p_template_ids) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.workflows WHERE organization_id=org AND id=ANY(p_workflow_ids) ORDER BY id FOR SHARE;
  IF p_services_provided AND EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes,p_template_ids,p_workflow_ids) wanted(id,code,template_id,workflow_id)
    WHERE NOT wanted.code=ANY(public.instrument_service_type_codes())
    OR (wanted.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN LATERAL (
      SELECT kind FROM public.template_versions WHERE organization_id=org AND template_id=template.id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1
    ) version ON version.kind='equipment_service_log' WHERE template.organization_id=org AND template.id=wanted.template_id AND template.active))
    OR (wanted.workflow_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflows WHERE organization_id=org AND id=wanted.workflow_id AND active AND applies_to='instrument_service'))) THEN
    RAISE EXCEPTION 'Select a supported Instrument service type and matching templates/workflows' USING ERRCODE='23514',CONSTRAINT='instrument_service_reference';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_service_ids,p_service_codes) wanted(id,code)
    JOIN public.instrument_version_services previous ON previous.organization_id=org AND previous.instrument_id=target_id AND previous.id=wanted.id
    WHERE previous.service_code<>wanted.code) THEN
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
    INSERT INTO public.instrument_version_services(organization_id,instrument_id,revision,id,position,service_code,service_label,
      template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count)
      SELECT org,target_id,next_revision,wanted.id,wanted.position-1,wanted.code,
        CASE wanted.code WHEN 'preventive_maintenance' THEN 'Preventive Maintenance' WHEN 'breakdown' THEN 'Breakdown' WHEN 'calibration' THEN 'Calibration' END,
        wanted.template_id,wanted.workflow_id,template.name,workflow.name,wanted.reminder,wanted.frequency,wanted.last_performed,wanted.reminder_frequency,wanted.next_reminder,wanted.active,
        (SELECT count(*) FROM unnest(p_role_service_ids) role(service_id) WHERE role.service_id=wanted.id)
      FROM unnest(p_service_ids,p_service_codes,p_template_ids,p_workflow_ids,p_reminder_before,p_frequency,p_last_performed,p_reminder_frequency,p_next_reminder,p_service_active)
        WITH ORDINALITY wanted(id,code,template_id,workflow_id,reminder,frequency,last_performed,reminder_frequency,next_reminder,active,position)
      LEFT JOIN public.workflows workflow ON workflow.organization_id=org AND workflow.id=wanted.workflow_id
      LEFT JOIN LATERAL (SELECT name FROM public.template_versions WHERE organization_id=org AND template_id=wanted.template_id AND snapshot_source_id IS NULL ORDER BY number DESC LIMIT 1) template ON true;
    INSERT INTO public.instrument_version_service_roles(organization_id,instrument_id,revision,service_id,role_id,position,role_name)
      SELECT org,target_id,next_revision,wanted.service_id,wanted.role_id,row_number() OVER(PARTITION BY wanted.service_id ORDER BY wanted.position)-1,role.name
      FROM unnest(p_role_service_ids,p_role_ids) WITH ORDINALITY wanted(service_id,role_id,position)
      JOIN public.roles role ON role.organization_id=org AND role.id=wanted.role_id;
  END IF;
  RETURN next_revision;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.instruments_copy_relations(target_id uuid, previous_revision integer, next_revision integer, copy_users boolean, copy_services boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE org uuid:=public.organization_module_scope();
BEGIN
  IF copy_users THEN
    INSERT INTO public.instrument_version_users(organization_id,instrument_id,revision,user_id,position,user_name,username)
      SELECT organization_id,instrument_id,next_revision,user_id,position,user_name,username FROM public.instrument_version_users
      WHERE organization_id=org AND instrument_id=target_id AND revision=previous_revision;
  END IF;
  IF copy_services THEN
    INSERT INTO public.instrument_version_services(organization_id,instrument_id,revision,id,position,service_code,service_label,
      template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count)
      SELECT organization_id,instrument_id,next_revision,id,position,service_code,service_label,
        template_id,workflow_id,template_name,workflow_name,reminder_before_days,frequency_days,last_performed_on,reminder_frequency_days,next_reminder_on,active,role_count
      FROM public.instrument_version_services WHERE organization_id=org AND instrument_id=target_id AND revision=previous_revision;
    INSERT INTO public.instrument_version_service_roles(organization_id,instrument_id,revision,service_id,role_id,position,role_name)
      SELECT organization_id,instrument_id,next_revision,service_id,role_id,position,role_name FROM public.instrument_version_service_roles
      WHERE organization_id=org AND instrument_id=target_id AND revision=previous_revision;
  END IF;
END $function$;
