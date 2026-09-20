ALTER TABLE approval_decision_checklist_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_check_read ON approval_decision_checklist_answers FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT laboratory_can_read()));
CREATE POLICY approval_check_insert ON approval_decision_checklist_answers FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('approvals.respond')));
GRANT SELECT,INSERT ON approval_decision_checklist_answers TO sampleify_app;
CREATE TRIGGER approval_check_history BEFORE UPDATE OR DELETE ON approval_decision_checklist_answers FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

CREATE FUNCTION workflow_guard_decision_check() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actual_transition uuid; actor uuid; decided timestamptz;
BEGIN
  SELECT approval.transition_id, decision.decided_by, decision.decided_at INTO actual_transition,actor,decided
    FROM public.approval_decisions decision JOIN public.approval_assignments assignment ON assignment.organization_id=decision.organization_id AND assignment.id=decision.approval_assignment_id
    JOIN public.approval_stages stage ON stage.organization_id=assignment.organization_id AND stage.id=assignment.approval_stage_id
    JOIN public.approval_cases approval ON approval.organization_id=stage.organization_id AND approval.id=stage.approval_case_id
    WHERE decision.organization_id=NEW.organization_id AND decision.id=NEW.decision_id;
  IF actual_transition IS DISTINCT FROM NEW.transition_id OR (current_user='sampleify_app' AND
    (actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR decided<>transaction_timestamp())) THEN
    RAISE EXCEPTION 'Checklist evidence belongs to the actual current decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decision_check_guard BEFORE INSERT ON approval_decision_checklist_answers FOR EACH ROW EXECUTE FUNCTION workflow_guard_decision_check();

CREATE FUNCTION workflow_validate_decision_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actual_transition uuid; assignment_status text;
BEGIN
  -- Imported history with no recorded checklist answers remains absent. The
  -- application role must submit actual checked items for each new decision.
  IF current_user<>'sampleify_app' THEN RETURN NULL; END IF;
  SELECT approval.transition_id,assignment.status INTO actual_transition,assignment_status
    FROM public.approval_assignments assignment JOIN public.approval_stages stage ON stage.organization_id=assignment.organization_id AND stage.id=assignment.approval_stage_id
    JOIN public.approval_cases approval ON approval.organization_id=stage.organization_id AND approval.id=stage.approval_case_id
    WHERE assignment.organization_id=NEW.organization_id AND assignment.id=NEW.approval_assignment_id;
  IF nullif(trim(NEW.comment),'') IS NULL OR assignment_status IS DISTINCT FROM (CASE WHEN NEW.decision='approve' THEN 'approved' ELSE 'rejected' END) THEN
    RAISE EXCEPTION 'A response requires its comment and matching assignment state' USING ERRCODE='23514';
  END IF;
  IF NEW.decision='approve' AND EXISTS (SELECT 1 FROM public.workflow_transition_checklist_items item
    WHERE item.organization_id=NEW.organization_id AND item.transition_id=actual_transition AND item.is_required
    AND NOT EXISTS (SELECT 1 FROM public.approval_decision_checklist_answers answer WHERE answer.organization_id=item.organization_id
      AND answer.decision_id=NEW.id AND answer.checklist_item_id=item.id AND answer.is_checked)) THEN
    RAISE EXCEPTION 'Approval requires its recorded required checklist answers' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER approval_decision_evidence AFTER INSERT ON approval_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_decision_evidence();

CREATE FUNCTION workflow_validate_request_checks() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_user<>'sampleify_app' OR NEW.transition_id IS NULL THEN RETURN NULL; END IF;
  IF (NEW.action='requested' OR (NEW.action IN ('transitioned','completed','cancelled') AND EXISTS (SELECT 1 FROM public.workflow_transitions
    WHERE organization_id=NEW.organization_id AND id=NEW.transition_id AND approval_mode='none')))
    AND EXISTS (SELECT 1 FROM public.workflow_transition_checklist_items item WHERE item.organization_id=NEW.organization_id AND item.transition_id=NEW.transition_id AND item.is_required
      AND NOT EXISTS (SELECT 1 FROM public.workflow_checklist_answers answer WHERE answer.organization_id=item.organization_id AND answer.history_id=NEW.id AND answer.checklist_item_id=item.id AND answer.is_checked)) THEN
    RAISE EXCEPTION 'Transition requires its recorded required checklist answers' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_request_checks AFTER INSERT ON workflow_run_history DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_request_checks();

CREATE FUNCTION workflow_validate_approved_case() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_user='sampleify_app' AND NEW.status='approved' AND NOT EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id
      JOIN public.workflow_transitions transition ON transition.organization_id=history.organization_id AND transition.id=history.transition_id
    WHERE run.organization_id=NEW.organization_id AND run.id=NEW.workflow_run_id AND run.revision>NEW.run_revision
      AND history.transition_id=NEW.transition_id AND history.occurred_at=NEW.resolved_at AND history.to_state_id=transition.target_state_id
      AND history.action IN ('approved','completed','cancelled')) THEN
    RAISE EXCEPTION 'Approval and its resulting workflow transition must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER approval_case_transition_evidence AFTER UPDATE ON approval_cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_approved_case();
