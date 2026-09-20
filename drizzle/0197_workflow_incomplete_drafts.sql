-- Save incomplete workflows as inactive drafts; preserve existing exact command receipts.
ALTER TABLE "workflow_editor_commands" DROP CONSTRAINT "workflow_editor_command_operation";
--> statement-breakpoint
ALTER TABLE "workflow_editor_commands" DROP CONSTRAINT "workflow_editor_command_revision";
--> statement-breakpoint
ALTER TABLE "workflow_editor_commands" DROP CONSTRAINT "workflow_editor_command_elements";
--> statement-breakpoint
ALTER TABLE "workflow_editor_commands" ADD CONSTRAINT "workflow_editor_command_operation" CHECK ("workflow_editor_commands"."operation" in ('create_state','patch_state','delete_state','create_transition','patch_transition','delete_transition','publish','save_draft'));
--> statement-breakpoint
ALTER TABLE "workflow_editor_commands" ADD CONSTRAINT "workflow_editor_command_revision" CHECK ("workflow_editor_commands"."source_revision">0 and "workflow_editor_commands"."revision">1 and (
    ("workflow_editor_commands"."source_version_id"="workflow_editor_commands"."workflow_version_id" and "workflow_editor_commands"."revision"="workflow_editor_commands"."source_revision"+1)
    or ("workflow_editor_commands"."source_version_id"<>"workflow_editor_commands"."workflow_version_id" and "workflow_editor_commands"."revision"=2 and "workflow_editor_commands"."operation" not in ('publish','save_draft'))));
--> statement-breakpoint
ALTER TABLE "workflow_editor_commands" ADD CONSTRAINT "workflow_editor_command_elements" CHECK ((
    ("workflow_editor_commands"."operation" in ('patch_state','delete_state','patch_transition','delete_transition') and "workflow_editor_commands"."source_element_id" is not null and "workflow_editor_commands"."element_id" is not null
      and ("workflow_editor_commands"."source_version_id"<>"workflow_editor_commands"."workflow_version_id" or "workflow_editor_commands"."source_element_id"="workflow_editor_commands"."element_id"))
    or ("workflow_editor_commands"."operation" in ('create_state','create_transition') and "workflow_editor_commands"."source_element_id" is null and "workflow_editor_commands"."element_id" is not null)
    or ("workflow_editor_commands"."operation" in ('publish','save_draft') and "workflow_editor_commands"."source_element_id" is null and "workflow_editor_commands"."element_id" is null)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workflow_editor_command_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; master public.workflows; source public.workflow_versions; target public.workflow_versions; present boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Workflow command receipts are immutable' USING ERRCODE='55000',CONSTRAINT='workflow_editor_command_immutable';
  END IF;
  actor:=public.workflow_metadata_require_actor();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid OR NEW.saved_by IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'Workflow command actor does not match the active session' USING ERRCODE='42501',CONSTRAINT='workflow_metadata_session_required';
  END IF;
  SELECT * INTO master FROM public.workflows WHERE organization_id=NEW.organization_id AND id=NEW.workflow_id FOR UPDATE;
  SELECT * INTO source FROM public.workflow_versions WHERE organization_id=NEW.organization_id AND id=NEW.source_version_id FOR UPDATE;
  IF NEW.workflow_version_id=NEW.source_version_id THEN target:=source;
  ELSE SELECT * INTO target FROM public.workflow_versions WHERE organization_id=NEW.organization_id AND id=NEW.workflow_version_id FOR UPDATE;
  END IF;
  PERFORM public.workflow_metadata_require_actor();
  IF master.id IS NULL OR NOT master.active OR source.workflow_id IS DISTINCT FROM master.id OR target.workflow_id IS DISTINCT FROM master.id
    OR target.revision IS DISTINCT FROM NEW.revision
    OR target.status IS DISTINCT FROM (CASE WHEN NEW.operation='publish' THEN 'published' ELSE 'draft' END) THEN
    RAISE EXCEPTION 'Workflow command result does not match the saved version' USING ERRCODE='23514',CONSTRAINT='workflow_editor_command_result';
  END IF;
  IF NEW.source_version_id<>NEW.workflow_version_id AND
    (source.status<>'published' OR source.revision<>NEW.source_revision OR target.created_by<>actor OR target.created_at<>transaction_timestamp()) THEN
    RAISE EXCEPTION 'Workflow command draft must be created from the requested published version in this transaction'
      USING ERRCODE='23514',CONSTRAINT='workflow_editor_command_source';
  END IF;
  IF NEW.operation IN ('create_state','patch_state') THEN
    SELECT EXISTS(SELECT 1 FROM public.workflow_states WHERE organization_id=NEW.organization_id AND workflow_version_id=NEW.workflow_version_id AND id=NEW.element_id) INTO present;
  ELSIF NEW.operation IN ('create_transition','patch_transition') THEN
    SELECT EXISTS(SELECT 1 FROM public.workflow_transitions WHERE organization_id=NEW.organization_id AND workflow_version_id=NEW.workflow_version_id AND id=NEW.element_id) INTO present;
  ELSIF NEW.operation='delete_state' THEN
    SELECT NOT EXISTS(SELECT 1 FROM public.workflow_states WHERE organization_id=NEW.organization_id AND id=NEW.element_id) INTO present;
  ELSIF NEW.operation='delete_transition' THEN
    SELECT NOT EXISTS(SELECT 1 FROM public.workflow_transitions WHERE organization_id=NEW.organization_id AND id=NEW.element_id) INTO present;
  ELSE present:=NEW.operation IN ('publish','save_draft');
  END IF;
  IF NOT present THEN
    RAISE EXCEPTION 'Workflow command element does not match the saved result' USING ERRCODE='23514',CONSTRAINT='workflow_editor_command_result';
  END IF;
  IF NEW.source_version_id<>NEW.workflow_version_id AND NEW.source_element_id IS NOT NULL THEN
    IF NEW.operation IN ('patch_state','delete_state') THEN
      SELECT EXISTS(SELECT 1 FROM public.workflow_states WHERE organization_id=NEW.organization_id AND workflow_version_id=NEW.source_version_id AND id=NEW.source_element_id) INTO present;
    ELSE
      SELECT EXISTS(SELECT 1 FROM public.workflow_transitions WHERE organization_id=NEW.organization_id AND workflow_version_id=NEW.source_version_id AND id=NEW.source_element_id) INTO present;
    END IF;
    IF NOT present THEN
      RAISE EXCEPTION 'Workflow command source element is unavailable' USING ERRCODE='23514',CONSTRAINT='workflow_editor_command_source';
    END IF;
  END IF;
  NEW.saved_at:=clock_timestamp(); NEW.created_transaction_id:=pg_current_xact_id();
  RETURN NEW;
END $$;
