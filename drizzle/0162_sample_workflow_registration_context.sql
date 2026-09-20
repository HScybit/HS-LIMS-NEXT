-- Reuse the existing actor/time/revision registration proof, including replay protection.
CREATE OR REPLACE FUNCTION laboratory_sample_workflow(p_sample_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; sample_kind text; selected_id uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('samples.create')
    OR public.laboratory_registering_sample() IS DISTINCT FROM p_sample_id THEN
    RAISE EXCEPTION 'Sample registration context required' USING ERRCODE='42501';
  END IF;
  SELECT sample.sample_type INTO sample_kind FROM public.samples sample WHERE sample.organization_id=org AND sample.id=p_sample_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample registration context required' USING ERRCODE='42501'; END IF;
  -- Meteor's registration form and ILC/PT models use the base workflow for these flags.
  SELECT CASE sample_kind
    WHEN 'customer' THEN settings.sample_workflow_base_id
    WHEN 'internal' THEN settings.sample_workflow_base_id
    WHEN 'interlaboratory' THEN settings.sample_workflow_base_id
    WHEN 'proficiency' THEN settings.sample_workflow_base_id
    WHEN 'quality_control' THEN settings.sample_workflow_iqc_id
    WHEN 'amendment' THEN settings.sample_workflow_amendment_id
    WHEN 'complaint' THEN settings.sample_workflow_complaint_id END
    INTO selected_id FROM public.organization_laboratory_settings settings WHERE settings.organization_id=org FOR SHARE;
  RETURN selected_id;
END $$;
