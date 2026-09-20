-- Preserve unchanged historical selections during unrelated organization settings updates.
CREATE OR REPLACE FUNCTION laboratory_guard_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_ids uuid[]; matched integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organization settings cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 THEN RAISE EXCEPTION 'Settings revisions start at one' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.organization_id<>OLD.organization_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Settings identity and revision are invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF session_user='sampleify_app' AND (NEW.updated_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.updated_at IS DISTINCT FROM transaction_timestamp()) THEN
    RAISE EXCEPTION 'Settings changes require the actual actor and time' USING ERRCODE='42501';
  END IF;
  IF NEW.result_summary_template_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.result_summary_template_id IS DISTINCT FROM OLD.result_summary_template_id)
    AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN public.template_versions version
    ON version.organization_id=template.organization_id AND version.template_id=template.id
    WHERE template.organization_id=NEW.organization_id AND template.id=NEW.result_summary_template_id AND template.active AND version.kind='datasheet')
  THEN RAISE EXCEPTION 'Select an active datasheet summary template' USING ERRCODE='23514'; END IF;
  IF NEW.job_workflow_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.job_workflow_id IS DISTINCT FROM OLD.job_workflow_id)
    AND NOT EXISTS (SELECT 1 FROM public.workflows workflow JOIN public.workflow_versions version
    ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
    WHERE workflow.organization_id=NEW.organization_id AND workflow.id=NEW.job_workflow_id AND workflow.active AND workflow.applies_to='test_request' AND version.status='published')
  THEN RAISE EXCEPTION 'Select a published test request workflow' USING ERRCODE='23514'; END IF;
  SELECT array_agg(DISTINCT selected.next_id) INTO selected_ids FROM unnest(ARRAY[NEW.sample_workflow_base_id,NEW.sample_workflow_iqc_id,NEW.sample_workflow_ilc_id,NEW.sample_workflow_pt_id,NEW.sample_workflow_amendment_id,NEW.sample_workflow_complaint_id],
    CASE WHEN TG_OP='UPDATE' THEN ARRAY[OLD.sample_workflow_base_id,OLD.sample_workflow_iqc_id,OLD.sample_workflow_ilc_id,OLD.sample_workflow_pt_id,OLD.sample_workflow_amendment_id,OLD.sample_workflow_complaint_id] ELSE ARRAY[NULL,NULL,NULL,NULL,NULL,NULL]::uuid[] END) selected(next_id,previous_id)
    WHERE selected.next_id IS NOT NULL AND selected.next_id IS DISTINCT FROM selected.previous_id;
  IF cardinality(selected_ids)>0 THEN
    -- Acquire each workflow lock once, in a consistent order, and recheck after waiting.
    PERFORM 1 FROM public.workflows workflow WHERE workflow.organization_id=NEW.organization_id AND workflow.id=ANY(selected_ids)
      AND workflow.active AND workflow.applies_to='sample' AND EXISTS (SELECT 1 FROM public.workflow_versions version
        WHERE version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published')
      ORDER BY workflow.id FOR SHARE OF workflow;
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>cardinality(selected_ids) THEN
      RAISE EXCEPTION 'Select an active published sample workflow' USING ERRCODE='23514',CONSTRAINT='sample_workflow_active_reference';
    END IF;
  END IF;
  RETURN NEW;
END $$;
