ALTER TABLE job_workflow_effects ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_workflow_effect_read ON job_workflow_effects FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT laboratory_can_read()));
GRANT SELECT ON job_workflow_effects TO sampleify_app;
CREATE TRIGGER job_workflow_effect_append_only BEFORE UPDATE OR DELETE ON job_workflow_effects FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

CREATE VIEW laboratory_job_workflow_effects WITH (security_invoker=true) AS
  SELECT effect.organization_id,effect.id,effect.parent_run_revision,effect.child_workflow_run_id,effect.child_run_revision,member.test_request_id,
    history.id AS parent_history_id,history.workflow_run_id AS parent_workflow_run_id,job.id AS parent_request_id,job.request_number AS parent_job_number,
    history.action,history.actor_user_id,history.comment,history.occurred_at,history.transition_id,
    target.id AS target_state_id,target.name AS target_state_name,target.state_type AS target_state_type,target.color AS target_color,source.name AS source_state_name,
    (child.final_datasheet_id=submission.datasheet_id AND sheet.latest_submission_id=member.submission_id
      AND (effect.child_workflow_run_id IS NULL OR child_run.revision=effect.child_run_revision+1)) AS is_current
  FROM job_workflow_effects effect JOIN job_submission_members member ON member.organization_id=effect.organization_id AND member.id=effect.job_submission_member_id
  JOIN test_requests child ON child.organization_id=member.organization_id AND child.id=member.test_request_id
  JOIN datasheet_submissions submission ON submission.organization_id=member.organization_id AND submission.id=member.submission_id
  JOIN datasheets sheet ON sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id
  LEFT JOIN workflow_runs child_run ON child_run.organization_id=effect.organization_id AND child_run.id=effect.child_workflow_run_id
  JOIN workflow_run_history history ON history.organization_id=effect.organization_id AND history.id=effect.parent_history_id
  JOIN workflow_runs parent_run ON parent_run.organization_id=history.organization_id AND parent_run.id=history.workflow_run_id
  JOIN test_requests job ON job.organization_id=parent_run.organization_id AND job.id=parent_run.test_request_id
  JOIN workflow_states target ON target.organization_id=history.organization_id AND target.id=history.to_state_id
  LEFT JOIN workflow_states source ON source.organization_id=history.organization_id AND source.id=history.from_state_id;
GRANT SELECT ON laboratory_job_workflow_effects TO sampleify_app;

-- Called only inside the authorized parent transition, after its actual history
-- exists. Runtime callers have no direct write or execute access to this helper.
CREATE FUNCTION workflow_apply_job_effects(history_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  parent_history public.workflow_run_history; parent_run public.workflow_runs; target public.workflow_states;
  job_id uuid; member record; applied integer:=0; next_status text;
BEGIN
  SELECT * INTO parent_history FROM public.workflow_run_history WHERE organization_id=org AND id=history_id;
  SELECT * INTO parent_run FROM public.workflow_runs WHERE organization_id=org AND id=parent_history.workflow_run_id;
  SELECT id INTO job_id FROM public.test_requests WHERE organization_id=org AND id=parent_run.test_request_id AND is_job;
  IF job_id IS NULL THEN RETURN 0; END IF;
  IF parent_history.actor_user_id IS DISTINCT FROM actor OR parent_history.to_state_id IS DISTINCT FROM parent_run.current_state_id
    OR parent_history.action NOT IN ('completed','cancelled','approved','transitioned')
    OR NOT EXISTS (SELECT 1 FROM public.workflow_run_history WHERE organization_id=org AND id=history_id AND xmin::text=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Job effects require this actual parent transition' USING ERRCODE='23514';
  END IF;
  SELECT * INTO target FROM public.workflow_states WHERE organization_id=org AND id=parent_history.to_state_id;
  next_status:=CASE WHEN target.state_type='cancelled' THEN 'cancelled' WHEN target.state_type='final' THEN 'completed' ELSE 'active' END;
  PERFORM 1 FROM public.test_requests WHERE organization_id=org AND parent_test_request_id=job_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.workflow_runs run JOIN public.test_requests child ON child.organization_id=run.organization_id AND child.id=run.test_request_id
    WHERE child.organization_id=org AND child.parent_test_request_id=job_id ORDER BY run.id FOR UPDATE OF run;
  FOR member IN SELECT chosen.id AS member_id,chosen.submission_id,child.id AS request_id,child.status AS request_status,child.sample_test_id,
      child.final_datasheet_id,submission.datasheet_id,sheet.latest_submission_id,sheet.status AS sheet_status,
      run.id AS run_id,run.workflow_version_id,run.current_state_id,run.revision AS run_revision,run.status AS run_status
    FROM public.job_submission_members chosen JOIN public.test_requests child ON child.organization_id=chosen.organization_id AND child.id=chosen.test_request_id
    JOIN public.datasheet_submissions submission ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id
    JOIN public.datasheets sheet ON sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id
    LEFT JOIN public.workflow_runs run ON run.organization_id=child.organization_id AND run.test_request_id=child.id
    WHERE chosen.organization_id=org AND chosen.parent_submission_id=parent_history.datasheet_submission_id AND child.parent_test_request_id=job_id
    ORDER BY child.id LOOP
    IF EXISTS (SELECT 1 FROM public.approval_cases WHERE organization_id=org AND workflow_run_id=member.run_id AND status='pending') THEN
      RAISE EXCEPTION 'A linked test request has an independent approval pending' USING ERRCODE='23514';
    END IF;
    IF (next_status='cancelled' AND member.request_status='cancelled') OR (next_status<>'cancelled' AND member.request_status='approved') THEN CONTINUE; END IF;
    IF member.final_datasheet_id IS DISTINCT FROM member.datasheet_id OR member.latest_submission_id IS DISTINCT FROM member.submission_id
      OR member.sheet_status NOT IN ('under_review','approved') OR member.request_status NOT IN ('under_review','approved')
      OR (next_status<>'cancelled' AND member.run_id IS NOT NULL AND member.run_status<>'active') THEN
      RAISE EXCEPTION 'A job decision must govern its unchanged submitted child results' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.job_workflow_effects(organization_id,parent_history_id,parent_run_revision,job_submission_member_id,
      child_workflow_run_id,child_workflow_version_id,child_state_id,child_run_revision)
      VALUES(org,history_id,parent_run.revision,member.member_id,member.run_id,member.workflow_version_id,member.current_state_id,member.run_revision);
    IF next_status='completed' THEN
      UPDATE public.test_requests SET status='approved',completed_at=parent_history.occurred_at,revision=revision+1 WHERE organization_id=org AND id=member.request_id;
      UPDATE public.datasheets SET status='approved',revision=revision+1 WHERE organization_id=org AND id=member.datasheet_id;
      UPDATE public.sample_tests SET status='completed' WHERE organization_id=org AND id=member.sample_test_id;
    ELSIF next_status='cancelled' THEN
      UPDATE public.test_requests SET status='cancelled',revision=revision+1 WHERE organization_id=org AND id=member.request_id;
      UPDATE public.datasheets SET status='void',revision=revision+1 WHERE organization_id=org AND test_request_id=member.request_id AND status<>'void';
    END IF;
    IF member.run_id IS NOT NULL THEN
      UPDATE public.workflow_runs SET status=next_status,revision=revision+1,
        completed_at=CASE WHEN next_status='active' THEN NULL ELSE parent_history.occurred_at END
        WHERE organization_id=org AND id=member.run_id;
    END IF;
    applied:=applied+1;
  END LOOP;
  RETURN applied;
END $$;

CREATE FUNCTION workflow_complete_job_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target_type text; member_request uuid; member_sheet uuid; parent_time timestamptz; parent_action text;
BEGIN
  SELECT target.state_type,chosen.test_request_id,submission.datasheet_id,history.occurred_at,history.action
    INTO target_type,member_request,member_sheet,parent_time,parent_action
    FROM public.job_submission_members chosen JOIN public.datasheet_submissions submission ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id
    JOIN public.workflow_run_history history ON history.organization_id=chosen.organization_id AND history.datasheet_submission_id=chosen.parent_submission_id AND history.id=NEW.parent_history_id
    JOIN public.workflow_states target ON target.organization_id=history.organization_id AND target.id=history.to_state_id
    WHERE chosen.organization_id=NEW.organization_id AND chosen.id=NEW.job_submission_member_id;
  IF member_request IS NULL OR parent_action NOT IN ('completed','cancelled','approved','transitioned') THEN
    RAISE EXCEPTION 'Job effect does not match its actual parent decision and child submission' USING ERRCODE='23514';
  END IF;
  -- A later transition in the same transaction may supersede the current status.
  IF EXISTS (SELECT 1 FROM public.job_workflow_effects WHERE organization_id=NEW.organization_id
    AND job_submission_member_id=NEW.job_submission_member_id AND parent_run_revision>NEW.parent_run_revision) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.test_requests request JOIN public.datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=member_sheet
      WHERE request.organization_id=NEW.organization_id AND request.id=member_request
        AND ((target_type='final' AND request.status='approved' AND sheet.status='approved' AND request.completed_at=parent_time)
          OR (target_type='cancelled' AND request.status='cancelled' AND sheet.status='void')
          OR (target_type NOT IN ('final','cancelled') AND request.status='under_review' AND sheet.status='under_review')))
    OR (NEW.child_workflow_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflow_runs
      WHERE organization_id=NEW.organization_id AND id=NEW.child_workflow_run_id AND test_request_id=member_request
        AND workflow_version_id=NEW.child_workflow_version_id AND current_state_id=NEW.child_state_id AND revision=NEW.child_run_revision+1
        AND status=CASE WHEN target_type='final' THEN 'completed' WHEN target_type='cancelled' THEN 'cancelled' ELSE 'active' END
        AND completed_at IS NOT DISTINCT FROM CASE WHEN target_type IN ('final','cancelled') THEN parent_time ELSE NULL END)) THEN
    RAISE EXCEPTION 'Actual child state changes and parent workflow evidence must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER job_workflow_effect_complete AFTER INSERT ON job_workflow_effects DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_complete_job_effect();

-- Forward integration with actual parent transitions and retirement evidence.

CREATE OR REPLACE FUNCTION workflow_apply_test_request_transition(selected_run uuid, selected_transition uuid, expected_revision integer, remarks text)
RETURNS TABLE(revision integer,status text,history_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  run public.workflow_runs; transition public.workflow_transitions; target public.workflow_states;
  approved boolean; next_status text; recorded_history uuid; result_id uuid;
BEGIN
  IF NOT public.workflow_lock_run(selected_run) OR actor IS NULL OR length(remarks)>5000 THEN RAISE EXCEPTION 'Invalid workflow transition request' USING ERRCODE='42501'; END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  SELECT * INTO transition FROM public.workflow_transitions WHERE organization_id=org AND id=selected_transition
    AND workflow_version_id=run.workflow_version_id AND source_state_id=run.current_state_id;
  IF run.status<>'active' OR run.revision<>expected_revision OR run.test_request_id IS NULL OR transition.id IS NULL
    OR EXISTS (SELECT 1 FROM public.approval_cases pending WHERE pending.organization_id=org AND pending.workflow_run_id=run.id AND pending.status='pending') THEN
    RAISE EXCEPTION 'Workflow changed or an approval is pending' USING ERRCODE='23514';
  END IF;
  result_id:=public.workflow_test_request_submission(run.test_request_id);
  IF result_id IS NULL THEN RAISE EXCEPTION 'A frozen submitted result and analyst allocation are required' USING ERRCODE='23514'; END IF;
  SELECT EXISTS (SELECT 1 FROM public.approval_cases approval JOIN public.workflow_run_history request_history ON request_history.organization_id=approval.organization_id AND request_history.id=approval.request_history_id
    JOIN public.approval_stages stage ON stage.organization_id=approval.organization_id AND stage.approval_case_id=approval.id
    JOIN public.approval_assignments assignment ON assignment.organization_id=stage.organization_id AND assignment.approval_stage_id=stage.id
    JOIN public.approval_decisions decision ON decision.organization_id=assignment.organization_id AND decision.approval_assignment_id=assignment.id
    WHERE approval.organization_id=org AND approval.workflow_run_id=run.id AND approval.transition_id=transition.id AND approval.run_revision=expected_revision
      AND approval.status='approved' AND approval.resolved_at=transaction_timestamp() AND decision.decided_by=actor AND decision.decided_at=transaction_timestamp()
      AND request_history.datasheet_submission_id=result_id) INTO approved;
  IF NOT ((transition.approval_mode='none' AND public.workflow_can_request(transition.id)) OR (approved AND public.app_has_permission('approvals.respond'))) THEN
    RAISE EXCEPTION 'This transition requires its configured approval for this result' USING ERRCODE='42501';
  END IF;
  IF transition.require_comment AND nullif(trim(remarks),'') IS NULL THEN RAISE EXCEPTION 'A transition comment is required' USING ERRCODE='23514'; END IF;
  SELECT * INTO target FROM public.workflow_states WHERE organization_id=org AND id=transition.target_state_id;
  next_status:=CASE WHEN target.state_type='cancelled' THEN 'cancelled' WHEN target.state_type='final' THEN 'completed' ELSE 'active' END;
  UPDATE public.workflow_runs stored SET current_state_id=target.id,status=next_status,revision=stored.revision+1,
    completed_at=CASE WHEN next_status<>'active' THEN transaction_timestamp() ELSE NULL END WHERE stored.organization_id=org AND stored.id=run.id;
  IF next_status='completed' THEN
    UPDATE public.test_requests request SET status='approved',completed_at=now(),revision=request.revision+1 WHERE request.organization_id=org AND request.id=run.test_request_id;
    -- Only the selected, submitted datasheet was approved by this transition.
    -- An unsubmitted alternative must never acquire invented approval evidence.
    UPDATE public.datasheets sheet SET status='approved',revision=sheet.revision+1 FROM public.test_requests request
      WHERE request.organization_id=org AND request.id=run.test_request_id AND sheet.organization_id=org AND sheet.id=request.final_datasheet_id;
    UPDATE public.sample_tests selected SET status='completed' FROM public.test_requests request
      WHERE request.organization_id=org AND request.id=run.test_request_id AND selected.organization_id=org AND selected.id=request.sample_test_id;
  ELSIF next_status='cancelled' THEN
    UPDATE public.test_requests request SET status='cancelled',revision=request.revision+1 WHERE request.organization_id=org AND request.id=run.test_request_id;
    UPDATE public.datasheets sheet SET status='void',revision=sheet.revision+1 WHERE sheet.organization_id=org AND sheet.test_request_id=run.test_request_id AND sheet.status<>'void';
  END IF;
  INSERT INTO public.workflow_run_history(organization_id,workflow_run_id,workflow_version_id,from_state_id,to_state_id,transition_id,datasheet_submission_id,action,actor_user_id,comment)
    VALUES(org,run.id,run.workflow_version_id,run.current_state_id,target.id,transition.id,result_id,
      CASE WHEN next_status='completed' THEN 'completed' WHEN next_status='cancelled' THEN 'cancelled' WHEN approved THEN 'approved' ELSE 'transitioned' END,actor,remarks) RETURNING id INTO recorded_history;
  PERFORM public.workflow_apply_job_effects(recorded_history);
  RETURN QUERY SELECT expected_revision+1,next_status,recorded_history;
END $$;

CREATE OR REPLACE FUNCTION laboratory_require_method_retirement_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (
    SELECT 1 FROM public.sample_events event WHERE event.organization_id=NEW.organization_id
      AND event.test_request_id=NEW.test_request_id AND event.datasheet_id=NEW.id AND event.event_type='datasheet_method_voided'
      AND event.actor_user_id=actor AND event.occurred_at=transaction_timestamp()
  ) AND NOT EXISTS (
    SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history
      ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.to_state_id=run.current_state_id
    JOIN public.test_requests request ON request.organization_id=run.organization_id AND request.id=run.test_request_id
    WHERE run.organization_id=NEW.organization_id AND run.test_request_id=NEW.test_request_id AND run.status='cancelled' AND request.status='cancelled'
      AND history.action='cancelled' AND history.actor_user_id=actor AND history.occurred_at=transaction_timestamp()
  ) AND NOT EXISTS (
    SELECT 1 FROM public.job_workflow_effects effect JOIN public.job_submission_members member
      ON member.organization_id=effect.organization_id AND member.id=effect.job_submission_member_id
    JOIN public.workflow_run_history history ON history.organization_id=effect.organization_id AND history.id=effect.parent_history_id
    JOIN public.test_requests request ON request.organization_id=member.organization_id AND request.id=member.test_request_id
    WHERE effect.organization_id=NEW.organization_id AND member.test_request_id=NEW.test_request_id AND request.status='cancelled'
      AND history.action='cancelled' AND history.actor_user_id=actor AND history.occurred_at=transaction_timestamp()
      AND effect.xmin::text=pg_current_xact_id()::text
  ) THEN RAISE EXCEPTION 'Method retirement requires its actual change or workflow cancellation evidence'  USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laboratory_submission_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND NOT EXISTS (SELECT 1 FROM public.datasheets sheet JOIN public.test_requests request
    ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id JOIN public.template_instances capture
    ON capture.organization_id=sheet.organization_id AND capture.id=NEW.instance_id
    WHERE sheet.organization_id=NEW.organization_id AND sheet.id=NEW.datasheet_id AND sheet.latest_submission_id=NEW.id
      AND ((sheet.status IN ('under_review','approved') AND request.status IN ('under_review','approved'))
        OR (sheet.status='void' AND request.status='cancelled' AND (
          EXISTS (SELECT 1 FROM public.workflow_run_history history JOIN public.workflow_runs run
            ON run.organization_id=history.organization_id AND run.id=history.workflow_run_id WHERE run.organization_id=NEW.organization_id AND run.test_request_id=request.id
              AND history.datasheet_submission_id=NEW.id AND history.action='cancelled' AND history.xmin::text=pg_current_xact_id()::text)
          OR EXISTS (SELECT 1 FROM public.job_workflow_effects effect JOIN public.job_submission_members member ON member.organization_id=effect.organization_id AND member.id=effect.job_submission_member_id
            JOIN public.workflow_run_history history ON history.organization_id=effect.organization_id AND history.id=effect.parent_history_id
            WHERE member.organization_id=NEW.organization_id AND member.submission_id=NEW.id AND member.test_request_id=request.id
              AND history.action='cancelled' AND effect.xmin::text=pg_current_xact_id()::text))))
      AND sheet.completed_by=NEW.submitted_by AND sheet.completed_at=NEW.submitted_at AND request.final_datasheet_id=sheet.id AND capture.status='frozen' AND capture.revision=NEW.capture_revision
      AND EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=sheet.organization_id AND event.test_request_id=request.id
        AND event.event_type='datasheet_submitted' AND event.actor_user_id=NEW.submitted_by AND event.xmin::text=pg_current_xact_id()::text)) THEN
    RAISE EXCEPTION 'Submission, frozen capture, owner status and actual audit event must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
