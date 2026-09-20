-- Session identity distinguishes application work inside scoped definer commands
-- from trusted import connections, including deferred triggers at commit.
CREATE FUNCTION workflow_generating_sample() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT run.sample_id FROM public.workflow_runs run JOIN public.workflow_states state
    ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE run.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
      AND run.id=nullif(current_setting('app.workflow_generation_run_id',true),'')::uuid AND run.sample_id IS NOT NULL AND state.generate_test_requests
      AND (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute') OR public.app_has_permission('approvals.respond'))
      AND EXISTS (SELECT 1 FROM public.workflow_run_history history WHERE history.organization_id=run.organization_id AND history.workflow_run_id=run.id
        AND history.to_state_id=run.current_state_id AND history.action IN ('transitioned','approved','completed')
        AND history.actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid AND history.occurred_at=transaction_timestamp())
$$;
REVOKE ALL ON FUNCTION workflow_generating_sample() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_generating_sample() TO sampleify_app;

DO $$ DECLARE relation text; scope_predicate text; BEGIN
  FOR relation,scope_predicate IN SELECT * FROM (VALUES
    ('test_requests','EXISTS (SELECT 1 FROM sample_tests t JOIN sample_products p ON p.organization_id=t.organization_id AND p.id=t.sample_product_id WHERE t.organization_id=test_requests.organization_id AND t.id=test_requests.sample_test_id AND p.sample_id=(SELECT workflow_generating_sample()))'),
    ('analytical_specifications','(SELECT workflow_generating_sample()) IS NOT NULL AND recorded_by=nullif(current_setting(''app.user_id'',true),'''')::uuid AND recorded_at=transaction_timestamp()'),
    ('analytical_specification_limits','EXISTS (SELECT 1 FROM analytical_specifications s WHERE s.organization_id=analytical_specification_limits.organization_id AND s.id=analytical_specification_limits.specification_id AND s.recorded_by=nullif(current_setting(''app.user_id'',true),'''')::uuid AND s.recorded_at=transaction_timestamp() AND (SELECT workflow_generating_sample()) IS NOT NULL)'),
    ('sample_events','sample_id=(SELECT workflow_generating_sample()) AND event_type=''test_requests_generated''')
  ) AS scopes(relation,predicate) LOOP
    EXECUTE format('CREATE POLICY workflow_generation_insert ON %I FOR INSERT TO sampleify_app WITH CHECK
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (%s))',relation,scope_predicate);
  END LOOP;
END $$;
CREATE POLICY workflow_generation_update ON sample_tests FOR UPDATE TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND status='planned'
    AND EXISTS (SELECT 1 FROM sample_products product WHERE product.organization_id=sample_tests.organization_id AND product.id=sample_tests.sample_product_id AND product.sample_id=(SELECT workflow_generating_sample())))
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND status='requested'
    AND EXISTS (SELECT 1 FROM sample_products product WHERE product.organization_id=sample_tests.organization_id AND product.id=sample_tests.sample_product_id AND product.sample_id=(SELECT workflow_generating_sample())));

CREATE OR REPLACE FUNCTION workflow_guard_decision_check() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actual_transition uuid; actor uuid; decided timestamptz;
BEGIN
  SELECT approval.transition_id, decision.decided_by, decision.decided_at INTO actual_transition,actor,decided
    FROM public.approval_decisions decision JOIN public.approval_assignments assignment ON assignment.organization_id=decision.organization_id AND assignment.id=decision.approval_assignment_id
    JOIN public.approval_stages stage ON stage.organization_id=assignment.organization_id AND stage.id=assignment.approval_stage_id
    JOIN public.approval_cases approval ON approval.organization_id=stage.organization_id AND approval.id=stage.approval_case_id
    WHERE decision.organization_id=NEW.organization_id AND decision.id=NEW.decision_id;
  IF actual_transition IS DISTINCT FROM NEW.transition_id OR (session_user='sampleify_app' AND
    (actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR decided<>transaction_timestamp())) THEN
    RAISE EXCEPTION 'Checklist evidence belongs to the actual current decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION workflow_validate_decision_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE actual_transition uuid; assignment_status text;
BEGIN
  -- Imported history with no recorded checklist answers remains absent. The
  -- application role must submit actual checked items for each new decision.
  IF session_user<>'sampleify_app' THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION workflow_validate_request_checks() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user<>'sampleify_app' OR NEW.transition_id IS NULL THEN RETURN NULL; END IF;
  IF (NEW.action='requested' OR (NEW.action IN ('transitioned','completed','cancelled') AND EXISTS (SELECT 1 FROM public.workflow_transitions
    WHERE organization_id=NEW.organization_id AND id=NEW.transition_id AND approval_mode='none')))
    AND EXISTS (SELECT 1 FROM public.workflow_transition_checklist_items item WHERE item.organization_id=NEW.organization_id AND item.transition_id=NEW.transition_id AND item.is_required
      AND NOT EXISTS (SELECT 1 FROM public.workflow_checklist_answers answer WHERE answer.organization_id=item.organization_id AND answer.history_id=NEW.id AND answer.checklist_item_id=item.id AND answer.is_checked)) THEN
    RAISE EXCEPTION 'Transition requires its recorded required checklist answers' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION workflow_validate_approved_case() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND NEW.status='approved' AND NOT EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id
      JOIN public.workflow_transitions transition ON transition.organization_id=history.organization_id AND transition.id=history.transition_id
    WHERE run.organization_id=NEW.organization_id AND run.id=NEW.workflow_run_id AND run.revision>NEW.run_revision
      AND history.transition_id=NEW.transition_id AND history.occurred_at=NEW.resolved_at AND history.to_state_id=transition.target_state_id
      AND history.action IN ('approved','completed','cancelled')) THEN
    RAISE EXCEPTION 'Approval and its resulting workflow transition must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION laboratory_lock_sample(sample_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate')
    OR sample_id IS NOT DISTINCT FROM public.laboratory_registering_sample() AND sample_id IS NOT NULL
    OR sample_id IS NOT DISTINCT FROM public.workflow_generating_sample() AND sample_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Sample allocation permission required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.samples WHERE organization_id = org AND id = sample_id FOR UPDATE;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION laboratory_next_number(sequence_name text, period text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid; next_number bigint; result_prefix text; width integer;
BEGIN
  IF org IS NULL OR sequence_name IS NULL OR period IS NULL OR period !~ '^[0-9]{4}$'
    OR sequence_name NOT IN ('sample', 'test_request', 'job') THEN RAISE EXCEPTION 'Invalid number sequence' USING ERRCODE = '23514'; END IF;
  IF NOT (sequence_name = 'sample' AND public.app_has_permission('samples.create')
    OR sequence_name <> 'sample' AND (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate') OR public.laboratory_registering_sample() IS NOT NULL OR (sequence_name = 'test_request' AND public.workflow_generating_sample() IS NOT NULL))) THEN
    RAISE EXCEPTION 'Number allocation permission required' USING ERRCODE = '42501';
  END IF;
  result_prefix := CASE sequence_name WHEN 'sample' THEN 'SMP-' WHEN 'test_request' THEN 'TR-' ELSE 'JOB-' END || period || '-';
  INSERT INTO public.number_sequences (organization_id, sequence_key, period_key, prefix, minimum_width)
    VALUES (org, sequence_name, period, result_prefix, CASE sequence_name WHEN 'job' THEN 4 ELSE 6 END) ON CONFLICT DO NOTHING;
  UPDATE public.number_sequences SET next_value = next_value + 1 WHERE organization_id = org AND sequence_key = sequence_name AND period_key = period
    RETURNING next_value - 1, prefix, minimum_width INTO next_number, result_prefix, width;
  RETURN result_prefix || lpad(next_number::text, greatest(width, length(next_number::text)), '0');
END $$;
