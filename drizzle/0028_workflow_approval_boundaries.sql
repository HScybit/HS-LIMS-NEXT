-- Versioned workflow details and typed, append-only approval evidence.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['workflow_transition_creator_roles', 'workflow_transition_approver_roles',
    'workflow_transition_cc_roles', 'workflow_transition_cc_emails', 'workflow_transition_conditions', 'workflow_transition_checklist_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY workflow_detail_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
        (SELECT laboratory_can_read() OR app_has_permission(''workflows.read'') OR app_has_permission(''workflows.manage'')))', relation);
    EXECUTE format('CREATE POLICY workflow_detail_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''workflows.manage'')))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT app_has_permission(''workflows.manage'')))', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sampleify_app', relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['approval_cases', 'approval_stages', 'approval_assignments', 'approval_decisions', 'workflow_checklist_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY approval_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND (SELECT laboratory_can_read()))', relation);
    EXECUTE format('CREATE POLICY approval_write ON %I FOR ALL TO sampleify_app USING
      (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
        (SELECT app_has_permission(''samples.manage'') OR app_has_permission(''datasheets.execute'') OR app_has_permission(''approvals.respond'')))
      WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid AND
        (SELECT app_has_permission(''samples.manage'') OR app_has_permission(''datasheets.execute'') OR app_has_permission(''approvals.respond'')))', relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sampleify_app', relation);
  END LOOP;
END $$;
GRANT UPDATE ON approval_cases, approval_stages, approval_assignments TO sampleify_app;
CREATE POLICY workflow_approval_history ON workflow_run_history FOR INSERT TO sampleify_app WITH CHECK
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('approvals.respond')));

CREATE FUNCTION workflow_guard_transition_detail() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org uuid; selected_transition uuid; version_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; selected_transition := OLD.transition_id;
  ELSE org := NEW.organization_id; selected_transition := NEW.transition_id; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.transition_id) IS DISTINCT FROM (OLD.organization_id, OLD.transition_id) THEN
    RAISE EXCEPTION 'Workflow detail ownership is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT version.status INTO version_status FROM public.workflow_versions version JOIN public.workflow_transitions transition
    ON transition.organization_id = version.organization_id AND transition.workflow_version_id = version.id
    WHERE transition.organization_id = org AND transition.id = selected_transition FOR UPDATE OF version;
  IF version_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only draft workflow details may change' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['workflow_transition_creator_roles', 'workflow_transition_approver_roles',
    'workflow_transition_cc_roles', 'workflow_transition_cc_emails', 'workflow_transition_conditions', 'workflow_transition_checklist_items'] LOOP
    EXECUTE format('CREATE TRIGGER workflow_detail_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION workflow_guard_transition_detail()', relation);
  END LOOP;
END $$;
CREATE TRIGGER workflow_condition_identity BEFORE UPDATE ON workflow_transition_conditions FOR EACH ROW EXECUTE FUNCTION laboratory_guard_identity();
CREATE TRIGGER workflow_checklist_identity BEFORE UPDATE ON workflow_transition_checklist_items FOR EACH ROW EXECUTE FUNCTION laboratory_guard_identity();

CREATE FUNCTION workflow_guard_approval_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status = 'published' AND OLD.status = 'draft' AND EXISTS (
    SELECT 1 FROM public.workflow_transitions transition WHERE transition.organization_id = NEW.organization_id AND transition.workflow_version_id = NEW.id AND
      ((transition.approval_mode = 'none') = EXISTS (SELECT 1 FROM public.workflow_transition_approver_roles role
        WHERE role.organization_id = transition.organization_id AND role.transition_id = transition.id)
      OR (transition.approval_mode <> 'sequential' AND EXISTS (SELECT 1 FROM public.workflow_transition_approver_roles role
        WHERE role.organization_id = transition.organization_id AND role.transition_id = transition.id AND role.stage_number <> 1)))) THEN
    RAISE EXCEPTION 'Approval modes require matching configured stages' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_approval_publication BEFORE UPDATE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION workflow_guard_approval_publication();

CREATE FUNCTION workflow_approver_candidates(selected_transition uuid)
RETURNS TABLE(stage_number integer, role_id uuid, user_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT configured.stage_number, configured.role_id, membership.user_id, person.display_name
    FROM public.workflow_transition_approver_roles configured JOIN public.membership_roles assignment
      ON assignment.organization_id = configured.organization_id AND assignment.role_id = configured.role_id
    JOIN public.memberships membership ON membership.organization_id = assignment.organization_id AND membership.user_id = assignment.user_id AND membership.active
    JOIN public.users person ON person.id = membership.user_id AND person.active
    WHERE configured.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND configured.transition_id = selected_transition
      AND (public.laboratory_can_read() OR public.app_has_permission('workflows.manage'))
    ORDER BY configured.stage_number, membership.user_id, configured.role_id
$$;
REVOKE ALL ON FUNCTION workflow_approver_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_approver_candidates(uuid) TO sampleify_app;

CREATE FUNCTION workflow_guard_request_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE history public.workflow_run_history;
BEGIN
  IF TG_TABLE_NAME = 'workflow_run_history' THEN
    IF NEW.transition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflow_transitions transition
      WHERE transition.organization_id = NEW.organization_id AND transition.workflow_version_id = NEW.workflow_version_id AND transition.id = NEW.transition_id
        AND transition.source_state_id = NEW.from_state_id AND (transition.target_state_id = NEW.to_state_id OR (NEW.action = 'rejected' AND NEW.from_state_id = NEW.to_state_id))) THEN
      RAISE EXCEPTION 'History must identify the actual workflow edge' USING ERRCODE = '23514';
    END IF;
    IF current_user = 'sampleify_app' THEN NEW.occurred_at := transaction_timestamp(); END IF;
  ELSE
    SELECT * INTO history FROM public.workflow_run_history WHERE organization_id = NEW.organization_id AND id = NEW.history_id;
    IF history.transition_id IS DISTINCT FROM NEW.transition_id OR history.action NOT IN ('requested', 'transitioned', 'completed', 'cancelled')
      OR (current_user = 'sampleify_app' AND (history.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid OR history.occurred_at <> transaction_timestamp())) THEN
      RAISE EXCEPTION 'Checklist answers belong to the actual request' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_request_evidence BEFORE INSERT ON workflow_run_history FOR EACH ROW EXECUTE FUNCTION workflow_guard_request_evidence();
CREATE TRIGGER workflow_checklist_evidence BEFORE INSERT ON workflow_checklist_answers FOR EACH ROW EXECUTE FUNCTION workflow_guard_request_evidence();
CREATE TRIGGER workflow_checklist_history BEFORE UPDATE OR DELETE ON workflow_checklist_answers FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();
CREATE TRIGGER approval_decision_history BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

CREATE FUNCTION workflow_guard_approval_case() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE run public.workflow_runs; history public.workflow_run_history;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO run FROM public.workflow_runs WHERE organization_id = NEW.organization_id AND id = NEW.workflow_run_id;
    SELECT * INTO history FROM public.workflow_run_history WHERE organization_id = NEW.organization_id AND id = NEW.request_history_id;
    IF NEW.status <> 'pending' OR run.status IS DISTINCT FROM 'active' OR run.revision IS DISTINCT FROM NEW.run_revision
      OR history.workflow_run_id IS DISTINCT FROM run.id OR history.action IS DISTINCT FROM 'requested'
      OR history.from_state_id IS DISTINCT FROM run.current_state_id
      OR (current_user = 'sampleify_app' AND (history.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid OR history.occurred_at <> transaction_timestamp())) THEN
      RAISE EXCEPTION 'Approval case requires a current recorded request' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status <> 'pending' OR (NEW.organization_id, NEW.id, NEW.workflow_run_id, NEW.workflow_version_id, NEW.transition_id, NEW.request_history_id, NEW.run_revision)
      IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.workflow_run_id, OLD.workflow_version_id, OLD.transition_id, OLD.request_history_id, OLD.run_revision) THEN
      RAISE EXCEPTION 'Approval case identity and completed evidence are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'approved' AND (NOT EXISTS (SELECT 1 FROM public.approval_stages WHERE organization_id = NEW.organization_id AND approval_case_id = NEW.id)
      OR EXISTS (SELECT 1 FROM public.approval_stages WHERE organization_id = NEW.organization_id AND approval_case_id = NEW.id AND status <> 'approved')) THEN
      RAISE EXCEPTION 'Every approval stage must be approved' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'rejected' AND NOT EXISTS (SELECT 1 FROM public.approval_stages WHERE organization_id = NEW.organization_id AND approval_case_id = NEW.id AND status = 'rejected') THEN
      RAISE EXCEPTION 'Rejection requires an actual rejected stage' USING ERRCODE = '23514';
    END IF;
    IF current_user = 'sampleify_app' AND NEW.status <> 'pending' THEN NEW.resolved_at := transaction_timestamp(); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_case_guard BEFORE INSERT OR UPDATE ON approval_cases FOR EACH ROW EXECUTE FUNCTION workflow_guard_approval_case();

CREATE FUNCTION workflow_guard_approval_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'sampleify_app' AND (NEW.decided_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid OR NOT public.app_has_permission('approvals.respond')) THEN
    RAISE EXCEPTION 'Approval decision requires the actual authorized responder' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.approval_assignments assignment JOIN public.approval_stages stage
    ON stage.organization_id = assignment.organization_id AND stage.id = assignment.approval_stage_id
    JOIN public.approval_cases approval ON approval.organization_id = stage.organization_id AND approval.id = stage.approval_case_id
    JOIN public.workflow_runs run ON run.organization_id = approval.organization_id AND run.id = approval.workflow_run_id
    WHERE assignment.organization_id = NEW.organization_id AND assignment.id = NEW.approval_assignment_id AND assignment.assigned_user_id = NEW.decided_by
      AND assignment.status = 'pending' AND stage.status = 'pending' AND approval.status = 'pending' AND run.status = 'active' AND run.revision = approval.run_revision) THEN
    RAISE EXCEPTION 'Only the active assigned approver may respond' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'sampleify_app' THEN NEW.decided_at := transaction_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decision_guard BEFORE INSERT ON approval_decisions FOR EACH ROW EXECUTE FUNCTION workflow_guard_approval_decision();

CREATE FUNCTION workflow_guard_approval_stage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE approval public.approval_cases; history public.workflow_run_history; mode text;
BEGIN
  SELECT * INTO approval FROM public.approval_cases WHERE organization_id = NEW.organization_id AND id = NEW.approval_case_id;
  IF approval.status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'Completed approval stages are immutable' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO history FROM public.workflow_run_history WHERE organization_id = NEW.organization_id AND id = approval.request_history_id;
    SELECT approval_mode INTO mode FROM public.workflow_transitions WHERE organization_id = NEW.organization_id AND id = approval.transition_id;
    IF NEW.status NOT IN ('pending', 'waiting') OR NEW.completion_rule <> (CASE WHEN mode = 'any' THEN 'any' ELSE 'all' END)
      OR NOT EXISTS (SELECT 1 FROM public.workflow_transition_approver_roles WHERE organization_id = NEW.organization_id AND transition_id = approval.transition_id AND stage_number = NEW.stage_number)
      OR (current_user = 'sampleify_app' AND (history.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid OR history.occurred_at <> transaction_timestamp())) THEN
      RAISE EXCEPTION 'Approval stages must match the recorded request' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'pending' AND EXISTS (SELECT 1 FROM public.workflow_transition_approver_roles
      WHERE organization_id = NEW.organization_id AND transition_id = approval.transition_id AND stage_number < NEW.stage_number) THEN
      RAISE EXCEPTION 'Only the first approval stage may start pending' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status NOT IN ('pending', 'waiting') OR (NEW.organization_id, NEW.id, NEW.approval_case_id, NEW.stage_number, NEW.completion_rule)
      IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.approval_case_id, OLD.stage_number, OLD.completion_rule)
      OR (OLD.status = 'pending' AND NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
      RAISE EXCEPTION 'Approval stage identity and completed evidence are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'pending' AND (OLD.status <> 'waiting' OR EXISTS (SELECT 1 FROM public.approval_stages
      WHERE organization_id = NEW.organization_id AND approval_case_id = NEW.approval_case_id AND stage_number < NEW.stage_number AND status <> 'approved')) THEN
      RAISE EXCEPTION 'Earlier stages must approve before the next stage starts' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND (OLD.status <> 'pending'
      OR NOT EXISTS (SELECT 1 FROM public.approval_assignments WHERE organization_id = NEW.organization_id AND approval_stage_id = NEW.id AND status = 'approved')
      OR (NEW.completion_rule = 'all' AND EXISTS (SELECT 1 FROM public.approval_assignments WHERE organization_id = NEW.organization_id AND approval_stage_id = NEW.id AND status <> 'approved'))) THEN
      RAISE EXCEPTION 'Stage approval requires its recorded quorum' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'rejected' AND (OLD.status <> 'pending' OR NOT EXISTS (SELECT 1 FROM public.approval_assignments
      WHERE organization_id = NEW.organization_id AND approval_stage_id = NEW.id AND status = 'rejected')) THEN
      RAISE EXCEPTION 'Stage rejection requires a recorded rejection' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'waiting' THEN RAISE EXCEPTION 'Approval stages cannot return to waiting' USING ERRCODE = '23514'; END IF;
  END IF;
  IF current_user = 'sampleify_app' THEN
    IF NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status = 'waiting') THEN NEW.activated_at := transaction_timestamp(); END IF;
    IF NEW.status IN ('approved', 'rejected', 'cancelled') THEN NEW.resolved_at := transaction_timestamp(); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_stage_guard BEFORE INSERT OR UPDATE ON approval_stages FOR EACH ROW EXECUTE FUNCTION workflow_guard_approval_stage();

CREATE FUNCTION workflow_guard_approval_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE selected_transition uuid; selected_stage integer; history_id uuid; history public.workflow_run_history; decision public.approval_decisions;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT approval.transition_id, stage.stage_number, request.id INTO selected_transition, selected_stage, history_id
      FROM public.approval_stages stage JOIN public.approval_cases approval ON approval.organization_id = stage.organization_id AND approval.id = stage.approval_case_id
      JOIN public.workflow_run_history request ON request.organization_id = approval.organization_id AND request.id = approval.request_history_id
      WHERE stage.organization_id = NEW.organization_id AND stage.id = NEW.approval_stage_id AND approval.status = 'pending';
    SELECT * INTO history FROM public.workflow_run_history WHERE organization_id = NEW.organization_id AND id = history_id;
    IF NEW.status <> 'pending' OR selected_transition IS NULL
      OR (current_user = 'sampleify_app' AND (history.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid OR history.occurred_at <> transaction_timestamp()
        OR NOT EXISTS (SELECT 1 FROM public.workflow_approver_candidates(selected_transition) candidate
          WHERE candidate.stage_number = selected_stage AND candidate.role_id = NEW.source_role_id AND candidate.user_id = NEW.assigned_user_id))) THEN
      RAISE EXCEPTION 'Approval assignments must be active configured request recipients' USING ERRCODE = '42501';
    END IF;
    IF current_user = 'sampleify_app' THEN NEW.assigned_at := transaction_timestamp(); END IF;
  ELSE
    IF OLD.status <> 'pending' OR (NEW.organization_id, NEW.id, NEW.approval_stage_id, NEW.assigned_user_id, NEW.source_role_id, NEW.assigned_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.id, OLD.approval_stage_id, OLD.assigned_user_id, OLD.source_role_id, OLD.assigned_at) THEN
      RAISE EXCEPTION 'Approval assignment identity and responses are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status IN ('approved', 'rejected') THEN
      SELECT * INTO decision FROM public.approval_decisions WHERE organization_id = NEW.organization_id AND approval_assignment_id = NEW.id;
      IF decision.id IS NULL OR NEW.status <> (CASE WHEN decision.decision = 'approve' THEN 'approved' ELSE 'rejected' END) THEN
        RAISE EXCEPTION 'Assignment responses require their actual decision' USING ERRCODE = '23514';
      END IF;
      NEW.responded_at := decision.decided_at;
    ELSIF NEW.status <> 'cancelled' THEN RAISE EXCEPTION 'Assignments require a decision or cancellation' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_assignment_guard BEFORE INSERT OR UPDATE ON approval_assignments FOR EACH ROW EXECUTE FUNCTION workflow_guard_approval_assignment();
