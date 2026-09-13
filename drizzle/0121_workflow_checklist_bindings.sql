ALTER TABLE "workflow_transitions" ADD COLUMN "checklist_master_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD COLUMN "checklist_master_revision" integer;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_checklist_master_fk" FOREIGN KEY ("organization_id","checklist_master_id") REFERENCES "public"."checklists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_checklist_version_fk" FOREIGN KEY ("organization_id","checklist_master_id","checklist_master_revision") REFERENCES "public"."checklist_versions"("organization_id","checklist_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_transition_checklist_master" ON "workflow_transitions" USING btree ("organization_id","checklist_master_id") WHERE "workflow_transitions"."checklist_master_id" is not null;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_checklist_binding" CHECK ("workflow_transitions"."checklist_master_revision" is null or ("workflow_transitions"."checklist_master_id" is not null and "workflow_transitions"."checklist_master_revision">0));--> statement-breakpoint
CREATE VIEW "public"."workflow_checklist_labels" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT organization_id,id,name,is_active,revision FROM public.checklists
  WHERE retired_at is null AND organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('workflows.read') OR public.app_has_permission('workflows.manage'))
);
--> statement-breakpoint
REVOKE ALL ON workflow_checklist_labels FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON workflow_checklist_labels TO sampleify_app;

-- The caller holds the workflow/version locks. A shared master lock prevents
-- edits or retirement between selecting the prompts and committing the graph.
CREATE FUNCTION workflow_select_checklist(selected_checklist uuid)
RETURNS TABLE(master_revision integer,prompt text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; head public.checklists;
BEGIN
  PERFORM public.workflow_metadata_require_actor();
  SELECT * INTO head FROM public.checklists WHERE organization_id=org AND id=selected_checklist FOR SHARE;
  PERFORM public.workflow_metadata_require_actor();
  IF head.id IS NULL OR NOT head.is_active OR head.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'Select an active checklist in this organization' USING ERRCODE='23514',CONSTRAINT='workflow_checklist_unavailable';
  END IF;
  IF head.revision>0 THEN PERFORM public.checklists_assert_version(org,selected_checklist,head.revision,true); END IF;
  IF (SELECT count(*) FROM public.checklist_items WHERE organization_id=org AND checklist_id=selected_checklist) NOT BETWEEN 1 AND 200
    OR EXISTS (SELECT 1 FROM public.checklist_items item WHERE item.organization_id=org AND item.checklist_id=selected_checklist
      AND length(trim(item.prompt)) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'Checklist items are outside the authoring bounds' USING ERRCODE='23514',CONSTRAINT='workflow_checklist_unavailable';
  END IF;
  RETURN QUERY SELECT head.revision,item.prompt FROM public.checklist_items item
    WHERE item.organization_id=org AND item.checklist_id=selected_checklist ORDER BY item.display_order,item.id;
END $$;

CREATE FUNCTION workflow_guard_checklist_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.checklist_master_id IS NOT NULL THEN
    -- Inactive masters remain valid historical references during either clone.
    PERFORM 1 FROM public.checklists WHERE organization_id=NEW.organization_id AND id=NEW.checklist_master_id AND retired_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workflow checklist is retired or unavailable' USING ERRCODE='23514',CONSTRAINT='workflow_checklist_unavailable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_checklist_reference BEFORE INSERT OR UPDATE ON workflow_transitions
  FOR EACH ROW EXECUTE FUNCTION workflow_guard_checklist_reference();

CREATE FUNCTION checklists_guard_retirement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND EXISTS
    (SELECT 1 FROM public.workflow_transitions WHERE organization_id=NEW.organization_id AND checklist_master_id=NEW.id) THEN
    RAISE EXCEPTION 'Checklist is referenced by a workflow' USING ERRCODE='23514',CONSTRAINT='checklist_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_retirement_reference BEFORE UPDATE ON checklists FOR EACH ROW EXECUTE FUNCTION checklists_guard_retirement();

CREATE FUNCTION workflow_validate_checklist_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; target uuid; connection public.workflow_transitions;
  item_id uuid; current_item public.workflow_transition_checklist_items; expected_prompt text; expected_count integer;
BEGIN
  org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF TG_TABLE_NAME='workflow_transitions' THEN target:=NEW.id;
  ELSE target:=CASE WHEN TG_OP='DELETE' THEN OLD.transition_id ELSE NEW.transition_id END; END IF;
  SELECT * INTO connection FROM public.workflow_transitions WHERE organization_id=org AND id=target;
  -- NULL records an unbound graph or an imported master without a known version.
  -- Its copied workflow prompts remain frozen by the existing version guards.
  IF NOT FOUND OR connection.checklist_master_revision IS NULL THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='workflow_transition_checklist_items' THEN
    -- Validate each changed item and the final count. The parent trigger below
    -- validates the whole snapshot whenever its master or version can change.
    -- Item ownership is immutable, so a deleted/replaced row cannot escape both
    -- this count check and the replacement row's ordered prompt check.
    SELECT item_count INTO expected_count FROM public.checklist_versions
      WHERE organization_id=org AND checklist_id=connection.checklist_master_id AND revision=connection.checklist_master_revision;
    IF (SELECT count(*) FROM public.workflow_transition_checklist_items WHERE organization_id=org AND transition_id=target) IS DISTINCT FROM expected_count THEN
      RAISE EXCEPTION 'Workflow checklist must contain its complete recorded master version'
        USING ERRCODE='23514',CONSTRAINT='workflow_checklist_snapshot';
    END IF;
    item_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    SELECT * INTO current_item FROM public.workflow_transition_checklist_items WHERE organization_id=org AND transition_id=target AND id=item_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT prompt INTO expected_prompt FROM public.checklist_version_items
      WHERE organization_id=org AND checklist_id=connection.checklist_master_id AND revision=connection.checklist_master_revision
      ORDER BY display_order,id OFFSET current_item.display_order LIMIT 1;
    IF NOT FOUND OR current_item.prompt IS DISTINCT FROM expected_prompt OR NOT current_item.is_required THEN
      RAISE EXCEPTION 'Workflow checklist item must match its ordered recorded master prompt'
        USING ERRCODE='23514',CONSTRAINT='workflow_checklist_snapshot';
    END IF;
    RETURN NULL;
  END IF;
  IF EXISTS (
    WITH expected AS (
      SELECT prompt,true AS is_required,(row_number() OVER (ORDER BY display_order,id)-1)::integer AS display_order
      FROM public.checklist_version_items WHERE organization_id=org AND checklist_id=connection.checklist_master_id AND revision=connection.checklist_master_revision
    ), actual AS (
      SELECT prompt,is_required,display_order FROM public.workflow_transition_checklist_items WHERE organization_id=org AND transition_id=target
    )
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'Workflow checklist must match its complete recorded master version'
      USING ERRCODE='23514',CONSTRAINT='workflow_checklist_snapshot';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_checklist_binding_complete AFTER INSERT OR UPDATE ON workflow_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_validate_checklist_snapshot();
CREATE CONSTRAINT TRIGGER workflow_checklist_items_complete AFTER INSERT OR UPDATE OR DELETE ON workflow_transition_checklist_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_validate_checklist_snapshot();

REVOKE ALL ON FUNCTION workflow_select_checklist(uuid),workflow_guard_checklist_reference(),checklists_guard_retirement(),workflow_validate_checklist_snapshot()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION workflow_select_checklist(uuid) TO sampleify_app;

--> statement-breakpoint
-- Copy the recorded binding alongside the unchanged frozen graph; never refresh from the current master.
CREATE OR REPLACE FUNCTION workflow_master_clone(source_id uuid,target_id uuid,requested_id uuid,requested_version uuid,observed_metadata_revision integer,code_base text)
RETURNS TABLE(workflow_id uuid,version_id uuid,metadata_revision integer,revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  source_workflow public.workflows; source_version public.workflow_versions; prior public.workflow_clone_origins;
  copied_version uuid; copied_revision integer; name_base text; next_name text; suffix integer:=2;
  state_ids uuid[]; state_copy_ids uuid[]; transition_ids uuid[]; transition_copy_ids uuid[];
BEGIN
  actor:=public.workflow_metadata_require_actor();
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  actor:=public.workflow_metadata_require_actor();
  IF source_id IS NULL OR target_id IS NULL OR requested_id IS NULL OR source_id=target_id THEN
    RAISE EXCEPTION 'Invalid workflow clone identity' USING ERRCODE='23514',CONSTRAINT='workflow_clone_input';
  END IF;
  SELECT * INTO prior FROM public.workflow_clone_origins origin WHERE origin.organization_id=org AND origin.request_id=requested_id;
  IF FOUND THEN
    IF (prior.workflow_id,prior.source_workflow_id,prior.requested_source_version_id,prior.created_by)
      IS DISTINCT FROM (target_id,source_id,requested_version,actor) THEN
      RAISE EXCEPTION 'The clone request was already used for a different change' USING ERRCODE='23514',CONSTRAINT='workflow_clone_request_reused';
    END IF;
    RETURN QUERY SELECT prior.workflow_id,prior.workflow_version_id,1,prior.cloned_revision; RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM public.workflow_metadata_versions history WHERE history.organization_id=org AND history.request_id=requested_id) THEN
    RAISE EXCEPTION 'The clone request was already used for another workflow command' USING ERRCODE='23514',CONSTRAINT='workflow_clone_request_reused';
  END IF;
  SELECT * INTO source_workflow FROM public.workflows workflow WHERE workflow.organization_id=org AND workflow.id=source_id AND workflow.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workflow was not found' USING ERRCODE='P0002',CONSTRAINT='workflow_metadata_not_found'; END IF;
  IF observed_metadata_revision IS DISTINCT FROM source_workflow.metadata_revision THEN
    RAISE EXCEPTION 'Workflow details changed before cloning' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_stale';
  END IF;
  IF code_base IS NULL OR length(code_base) NOT BETWEEN 1 AND 56 OR code_base !~ '^[-A-Z0-9._/]+$' THEN
    RAISE EXCEPTION 'Invalid workflow clone code' USING ERRCODE='23514',CONSTRAINT='workflow_clone_input';
  END IF;
  SELECT * INTO source_version FROM public.workflow_versions version
    WHERE version.organization_id=org AND version.workflow_id=source_id
      AND ((requested_version IS NOT NULL AND version.id=requested_version) OR (requested_version IS NULL AND version.status IN ('draft','published')))
    ORDER BY CASE version.status WHEN 'draft' THEN 0 ELSE 1 END,version.number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    IF requested_version IS NULL THEN RAISE EXCEPTION 'The workflow has no version to clone' USING ERRCODE='23514',CONSTRAINT='workflow_clone_version_required';
    ELSE RAISE EXCEPTION 'The selected version does not belong to this workflow' USING ERRCODE='23514',CONSTRAINT='workflow_clone_invalid_version'; END IF;
  END IF;
  name_base:=source_workflow.name||' - Copy'; next_name:=name_base;
  WHILE EXISTS(SELECT 1 FROM public.workflows workflow WHERE workflow.organization_id=org AND workflow.active AND workflow.name=next_name) LOOP
    next_name:=name_base||' '||suffix::text; suffix:=suffix+1;
  END LOOP;
  IF length(next_name)>200 THEN RAISE EXCEPTION 'Shorten the workflow name before cloning' USING ERRCODE='23514',CONSTRAINT='workflow_clone_name_too_long'; END IF;
  SELECT created.initial_version_id INTO copied_version FROM public.workflows_metadata_write(
    'create',target_id,0,requested_id,next_name,source_workflow.description,true,code_base,true,source_workflow.applies_to,true) created;
  UPDATE public.workflow_versions SET change_summary='Cloned from '||source_workflow.code,revision=workflow_versions.revision+1
    WHERE organization_id=org AND id=copied_version RETURNING workflow_versions.revision INTO copied_revision;

  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]),coalesce(array_agg(new_id ORDER BY id),'{}'::uuid[])
    INTO state_ids,state_copy_ids FROM (SELECT state.id,gen_random_uuid() new_id FROM public.workflow_states state
      WHERE state.organization_id=org AND state.workflow_version_id=source_version.id) identities;
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]),coalesce(array_agg(new_id ORDER BY id),'{}'::uuid[])
    INTO transition_ids,transition_copy_ids FROM (SELECT transition.id,gen_random_uuid() new_id FROM public.workflow_transitions transition
      WHERE transition.organization_id=org AND transition.workflow_version_id=source_version.id) identities;

  INSERT INTO public.workflow_states("organization_id","id","workflow_version_id","code","name","description","state_type","display_order","color","canvas_x","canvas_y","input_count","output_count","badge_style","template_id","show_sample_edit","show_sample_retest","show_sample_reissue","enable_template_validation","enable_critical_parameters_validation","show_add_result","generate_test_requests","require_all_test_requests_allocated","require_all_test_requests_approved","fetch_environment_data","can_work_on_test_request","is_positive_termination","enable_job_card")
    SELECT source."organization_id",map.new_id,copied_version,source."code",source."name",source."description",source."state_type",source."display_order",source."color",source."canvas_x",source."canvas_y",source."input_count",source."output_count",source."badge_style",source."template_id",source."show_sample_edit",source."show_sample_retest",source."show_sample_reissue",source."enable_template_validation",source."enable_critical_parameters_validation",source."show_add_result",source."generate_test_requests",source."require_all_test_requests_allocated",source."require_all_test_requests_approved",source."fetch_environment_data",source."can_work_on_test_request",source."is_positive_termination",source."enable_job_card"
    FROM public.workflow_states source JOIN unnest(state_ids,state_copy_ids) AS map(id,new_id) ON map.id=source.id WHERE source.organization_id=org;
  INSERT INTO public.workflow_state_capability_roles("organization_id","workflow_state_id","capability","role_id")
    SELECT source."organization_id",map.new_id,source."capability",source."role_id"
    FROM public.workflow_state_capability_roles source JOIN unnest(state_ids,state_copy_ids) AS map(id,new_id) ON map.id=source.workflow_state_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transitions("organization_id","id","workflow_version_id","code","name","source_state_id","target_state_id","approval_mode","source_port","target_port","auto_execute","require_comment","display_order","checklist_master_id","checklist_master_revision")
    SELECT source."organization_id",map.new_id,copied_version,source."code",source."name",source_map.new_id,target_map.new_id,source."approval_mode",source."source_port",source."target_port",source."auto_execute",source."require_comment",source."display_order",source."checklist_master_id",source."checklist_master_revision"
    FROM public.workflow_transitions source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.id
      JOIN unnest(state_ids,state_copy_ids) AS source_map(id,new_id) ON source_map.id=source.source_state_id
      JOIN unnest(state_ids,state_copy_ids) AS target_map(id,new_id) ON target_map.id=source.target_state_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transition_creator_roles("organization_id","transition_id","role_id")
    SELECT source."organization_id",map.new_id,source."role_id"
    FROM public.workflow_transition_creator_roles source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.transition_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transition_approver_roles("organization_id","transition_id","role_id","stage_number")
    SELECT source."organization_id",map.new_id,source."role_id",source."stage_number"
    FROM public.workflow_transition_approver_roles source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.transition_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transition_cc_roles("organization_id","transition_id","role_id")
    SELECT source."organization_id",map.new_id,source."role_id"
    FROM public.workflow_transition_cc_roles source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.transition_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transition_cc_emails("organization_id","transition_id","email")
    SELECT source."organization_id",map.new_id,source."email"
    FROM public.workflow_transition_cc_emails source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.transition_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transition_conditions("organization_id","id","transition_id","source_field","operator","comparison_text","comparison_number","comparison_boolean","comparison_date","display_order")
    SELECT source."organization_id",gen_random_uuid(),map.new_id,source."source_field",source."operator",source."comparison_text",source."comparison_number",source."comparison_boolean",source."comparison_date",source."display_order"
    FROM public.workflow_transition_conditions source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.transition_id WHERE source.organization_id=org;
  INSERT INTO public.workflow_transition_checklist_items("organization_id","id","transition_id","prompt","is_required","display_order")
    SELECT source."organization_id",gen_random_uuid(),map.new_id,source."prompt",source."is_required",source."display_order"
    FROM public.workflow_transition_checklist_items source JOIN unnest(transition_ids,transition_copy_ids) AS map(id,new_id) ON map.id=source.transition_id WHERE source.organization_id=org;

  INSERT INTO public.sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to,is_default)
    SELECT org,assignment.sample_category_id,target_id,assignment.applies_to,false FROM public.sample_category_workflows assignment
    WHERE assignment.organization_id=org AND assignment.workflow_id=source_id;
  INSERT INTO public.workflow_clone_origins(organization_id,workflow_id,workflow_version_id,cloned_revision,source_workflow_id,source_version_id,
    source_revision,source_metadata_revision,requested_source_version_id,request_id,created_by)
    VALUES(org,target_id,copied_version,copied_revision,source_id,source_version.id,source_version.revision,source_workflow.metadata_revision,requested_version,requested_id,actor);
  RETURN QUERY SELECT target_id,copied_version,1,copied_revision;
END $$;
