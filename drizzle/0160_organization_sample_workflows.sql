-- Source organization sample workflow configuration; leave existing assignments empty.
ALTER TABLE organization_laboratory_settings
  ADD COLUMN sample_workflow_base_id uuid,
  ADD COLUMN sample_workflow_iqc_id uuid,
  ADD COLUMN sample_workflow_ilc_id uuid,
  ADD COLUMN sample_workflow_pt_id uuid,
  ADD COLUMN sample_workflow_amendment_id uuid,
  ADD COLUMN sample_workflow_complaint_id uuid;
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_sample_base_workflow_fk
  FOREIGN KEY (organization_id,sample_workflow_base_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_sample_iqc_workflow_fk
  FOREIGN KEY (organization_id,sample_workflow_iqc_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_sample_ilc_workflow_fk
  FOREIGN KEY (organization_id,sample_workflow_ilc_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_sample_pt_workflow_fk
  FOREIGN KEY (organization_id,sample_workflow_pt_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_sample_amendment_workflow_fk
  FOREIGN KEY (organization_id,sample_workflow_amendment_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
ALTER TABLE organization_laboratory_settings ADD CONSTRAINT lab_settings_sample_complaint_workflow_fk
  FOREIGN KEY (organization_id,sample_workflow_complaint_id) REFERENCES workflows(organization_id,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_guard_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  IF NEW.result_summary_template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.templates template JOIN public.template_versions version
    ON version.organization_id=template.organization_id AND version.template_id=template.id
    WHERE template.organization_id=NEW.organization_id AND template.id=NEW.result_summary_template_id AND template.active AND version.kind='datasheet')
  THEN RAISE EXCEPTION 'Select an active datasheet summary template' USING ERRCODE='23514'; END IF;
  IF NEW.job_workflow_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflows workflow JOIN public.workflow_versions version
    ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
    WHERE workflow.organization_id=NEW.organization_id AND workflow.id=NEW.job_workflow_id AND workflow.active AND workflow.applies_to='test_request' AND version.status='published')
  THEN RAISE EXCEPTION 'Select a published test request workflow' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.sample_workflow_base_id,NEW.sample_workflow_iqc_id,NEW.sample_workflow_ilc_id,NEW.sample_workflow_pt_id,NEW.sample_workflow_amendment_id,NEW.sample_workflow_complaint_id],
      CASE WHEN TG_OP='UPDATE' THEN ARRAY[OLD.sample_workflow_base_id,OLD.sample_workflow_iqc_id,OLD.sample_workflow_ilc_id,OLD.sample_workflow_pt_id,OLD.sample_workflow_amendment_id,OLD.sample_workflow_complaint_id] ELSE ARRAY[NULL,NULL,NULL,NULL,NULL,NULL]::uuid[] END) selected(next_id,previous_id)
    WHERE selected.next_id IS NOT NULL AND selected.next_id IS DISTINCT FROM selected.previous_id
      AND NOT EXISTS (SELECT 1 FROM public.workflows workflow JOIN public.workflow_versions version
        ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
        WHERE workflow.organization_id=NEW.organization_id AND workflow.id=selected.next_id AND workflow.active
          AND workflow.applies_to='sample' AND version.status='published')) THEN
    RAISE EXCEPTION 'Select an active published sample workflow' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_settings_options() RETURNS TABLE(id uuid,kind text,label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('settings.read') OR public.app_has_permission('settings.manage')) THEN
    RAISE EXCEPTION 'Settings permission required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT template.id,'template'::text,latest.name FROM public.templates template
    JOIN LATERAL (SELECT version.name,version.kind FROM public.template_versions version
      WHERE version.organization_id=template.organization_id AND version.template_id=template.id ORDER BY version.number DESC LIMIT 1) latest ON latest.kind='datasheet'
    WHERE template.organization_id=org AND template.active
    UNION ALL SELECT workflow.id,'workflow'::text,workflow.name FROM public.workflows workflow
      WHERE workflow.organization_id=org AND workflow.active AND workflow.applies_to='test_request'
      AND EXISTS (SELECT 1 FROM public.workflow_versions version WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published')
    UNION ALL SELECT workflow.id,'sample_workflow'::text,workflow.name FROM public.workflows workflow
      WHERE workflow.organization_id=org AND workflow.active AND workflow.applies_to='sample'
      AND EXISTS (SELECT 1 FROM public.workflow_versions version WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published')
    UNION ALL SELECT workflow.id,'sample_workflow_retained'::text,workflow.name FROM public.workflows workflow
      JOIN public.organization_laboratory_settings settings ON settings.organization_id=workflow.organization_id
      WHERE workflow.organization_id=org AND workflow.id IN (settings.sample_workflow_base_id,settings.sample_workflow_iqc_id,settings.sample_workflow_ilc_id,settings.sample_workflow_pt_id,settings.sample_workflow_amendment_id,settings.sample_workflow_complaint_id)
      AND NOT (workflow.active AND workflow.applies_to='sample' AND EXISTS (SELECT 1 FROM public.workflow_versions version
        WHERE version.organization_id=org AND version.workflow_id=workflow.id AND version.status='published'));
END $$;
--> statement-breakpoint
-- This reads only the new sample's assignment and holds it stable until registration commits.
-- Call once through a MATERIALIZED scalar CTE; row locking makes this function volatile.
CREATE FUNCTION laboratory_sample_workflow(p_sample_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; sample_kind text; selected_id uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('samples.create')
    OR nullif(current_setting('app.registration_sample_id',true),'')::uuid IS DISTINCT FROM p_sample_id THEN
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION laboratory_sample_workflow(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laboratory_sample_workflow(uuid) TO sampleify_app;
