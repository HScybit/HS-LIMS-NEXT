-- Verify the whole request at commit, after its stages and assignments have
-- been inserted in batches. A configured stage or active recipient cannot be
-- silently omitted, including a stage whose configured roles have no users.
CREATE FUNCTION workflow_validate_new_case() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE requester uuid; mode text;
BEGIN
  SELECT actor_user_id INTO requester FROM public.workflow_run_history WHERE organization_id=NEW.organization_id AND id=NEW.request_history_id;
  SELECT approval_mode INTO mode FROM public.workflow_transitions WHERE organization_id=NEW.organization_id AND id=NEW.transition_id;
  IF mode IS NULL OR mode='none' THEN RAISE EXCEPTION 'This transition does not define approval' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_transition_creator_roles WHERE organization_id=NEW.organization_id AND transition_id=NEW.transition_id)
    AND NOT EXISTS (SELECT 1 FROM public.workflow_transition_creator_roles creator JOIN public.membership_roles membership
      ON membership.organization_id=creator.organization_id AND membership.role_id=creator.role_id
      WHERE creator.organization_id=NEW.organization_id AND creator.transition_id=NEW.transition_id AND membership.user_id=requester) THEN
    RAISE EXCEPTION 'The requester must hold a configured creator role' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_transition_approver_roles WHERE organization_id=NEW.organization_id AND transition_id=NEW.transition_id)
    OR EXISTS (SELECT 1 FROM public.workflow_transition_approver_roles configured WHERE configured.organization_id=NEW.organization_id AND configured.transition_id=NEW.transition_id
      AND NOT EXISTS (SELECT 1 FROM public.approval_stages stage WHERE stage.organization_id=NEW.organization_id AND stage.approval_case_id=NEW.id AND stage.stage_number=configured.stage_number))
    OR EXISTS (SELECT 1 FROM public.approval_stages stage WHERE stage.organization_id=NEW.organization_id AND stage.approval_case_id=NEW.id
      AND NOT EXISTS (SELECT 1 FROM public.approval_assignments assignment WHERE assignment.organization_id=stage.organization_id AND assignment.approval_stage_id=stage.id)) THEN
    RAISE EXCEPTION 'Every configured approval stage requires assigned users' USING ERRCODE='23514';
  END IF;
  IF current_user='sampleify_app' AND EXISTS (SELECT 1 FROM public.workflow_approver_candidates(NEW.transition_id) candidate
    WHERE NOT EXISTS (SELECT 1 FROM public.approval_stages stage JOIN public.approval_assignments assignment
      ON assignment.organization_id=stage.organization_id AND assignment.approval_stage_id=stage.id
      WHERE stage.organization_id=NEW.organization_id AND stage.approval_case_id=NEW.id AND stage.stage_number=candidate.stage_number AND assignment.assigned_user_id=candidate.user_id)) THEN
    RAISE EXCEPTION 'All configured active approvers must be included in the request' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_case_completeness AFTER INSERT ON approval_cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_new_case();
