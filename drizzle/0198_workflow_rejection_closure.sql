-- Keep imported rejection history unchanged. New application rejections link
-- their actual history entry and must commit all decision/owner evidence.
ALTER TABLE approval_cases ADD COLUMN rejection_history_id uuid;
ALTER TABLE approval_cases ADD CONSTRAINT approval_case_rejection_fk
  FOREIGN KEY (organization_id,rejection_history_id,transition_id)
  REFERENCES workflow_run_history(organization_id,id,transition_id);
ALTER TABLE approval_cases ADD CONSTRAINT approval_case_rejection_key UNIQUE(organization_id,rejection_history_id);
ALTER TABLE approval_cases ADD CONSTRAINT approval_case_rejection_state CHECK(rejection_history_id IS NULL OR status='rejected');
--> statement-breakpoint
CREATE FUNCTION workflow_reject_approval(p_assignment uuid,p_comment text,p_checked uuid[])
RETURNS TABLE(workflow_run_id uuid,revision integer,history_id uuid,approval_case_id uuid,state_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  selected_run uuid; assignment public.approval_assignments; stage public.approval_stages; approval public.approval_cases;
  run public.workflow_runs; requested public.workflow_run_history; decision public.approval_decisions;
  recorded_history uuid; recorded_decision uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('approvals.respond') THEN
    RAISE EXCEPTION 'Approval response permission and a current session are required' USING ERRCODE='42501',CONSTRAINT='workflow_response_session';
  END IF;
  IF p_assignment IS NULL OR nullif(trim(p_comment),'') IS NULL OR length(p_comment)>5000
    OR cardinality(p_checked) IS NULL OR cardinality(p_checked)>500
    OR (cardinality(p_checked)>0 AND array_ndims(p_checked) IS DISTINCT FROM 1)
    OR array_position(p_checked,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT item) FROM unnest(p_checked) item)<>cardinality(p_checked) THEN
    RAISE EXCEPTION 'Rejection requires a comment and distinct bounded checklist items' USING ERRCODE='23514',CONSTRAINT='workflow_response_input';
  END IF;
  p_comment:=trim(p_comment);
  SELECT c.workflow_run_id INTO selected_run FROM public.approval_assignments a
    JOIN public.approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
    JOIN public.approval_cases c ON c.organization_id=s.organization_id AND c.id=s.approval_case_id
    WHERE a.organization_id=org AND a.id=p_assignment;
  IF selected_run IS NULL THEN
    RAISE EXCEPTION 'Approval assignment was not found' USING ERRCODE='23514',CONSTRAINT='workflow_response_not_found';
  END IF;
  -- An already committed response is immutable. Its exact retry must still work
  -- after later workflow activity, without trying to execute the old edge again.
  IF NOT EXISTS (SELECT 1 FROM public.approval_decisions WHERE organization_id=org AND approval_assignment_id=p_assignment) THEN
    PERFORM public.workflow_lock_run(selected_run);
  END IF;
  SELECT a.* INTO assignment FROM public.approval_assignments a WHERE a.organization_id=org AND a.id=p_assignment FOR UPDATE;
  SELECT s.* INTO stage FROM public.approval_stages s WHERE s.organization_id=org AND s.id=assignment.approval_stage_id FOR UPDATE;
  SELECT c.* INTO approval FROM public.approval_cases c WHERE c.organization_id=org AND c.id=stage.approval_case_id FOR UPDATE;
  IF public.organization_module_scope() IS DISTINCT FROM org OR NOT public.app_has_permission('approvals.respond') THEN
    RAISE EXCEPTION 'Approval response access changed' USING ERRCODE='42501',CONSTRAINT='workflow_response_session';
  END IF;
  IF assignment.assigned_user_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'Only the assigned approver may respond' USING ERRCODE='42501',CONSTRAINT='workflow_response_assignee';
  END IF;
  SELECT d.* INTO decision FROM public.approval_decisions d WHERE d.organization_id=org AND d.approval_assignment_id=p_assignment;
  SELECT h.* INTO requested FROM public.workflow_run_history h WHERE h.organization_id=org AND h.id=approval.request_history_id;
  IF decision.id IS NOT NULL THEN
    IF decision.decision<>'reject' OR decision.decided_by<>actor OR decision.comment IS DISTINCT FROM p_comment
      OR approval.status<>'rejected' OR approval.rejection_history_id IS NULL
      OR (SELECT coalesce(array_agg(answer.checklist_item_id ORDER BY answer.checklist_item_id),'{}'::uuid[])
        FROM public.approval_decision_checklist_answers answer WHERE answer.organization_id=org AND answer.decision_id=decision.id AND answer.is_checked)
        IS DISTINCT FROM (SELECT coalesce(array_agg(item ORDER BY item),'{}'::uuid[]) FROM unnest(p_checked) item) THEN
      RAISE EXCEPTION 'This assignment already has a different response' USING ERRCODE='23514',CONSTRAINT='workflow_response_conflict';
    END IF;
    RETURN QUERY SELECT approval.workflow_run_id,approval.run_revision+1,approval.rejection_history_id,approval.id,requested.from_state_id;
    RETURN;
  END IF;
  SELECT r.* INTO run FROM public.workflow_runs r WHERE r.organization_id=org AND r.id=selected_run;
  IF assignment.status<>'pending' OR stage.status<>'pending' OR approval.status<>'pending'
    OR run.status<>'active' OR run.revision<>approval.run_revision OR run.current_state_id IS DISTINCT FROM requested.from_state_id THEN
    RAISE EXCEPTION 'This approval is no longer waiting for a response' USING ERRCODE='23514',CONSTRAINT='workflow_response_not_pending';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_checked) selected(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.workflow_transition_checklist_items item WHERE item.organization_id=org AND item.transition_id=approval.transition_id AND item.id=selected.id)) THEN
    RAISE EXCEPTION 'A selected checklist item does not belong to this transition' USING ERRCODE='23514',CONSTRAINT='workflow_response_checklist';
  END IF;
  -- Rejection does not require positive transition conditions, allocation or
  -- checked positive assertions. It still refers to the exact submitted result.
  IF run.test_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.test_requests request JOIN public.datasheets sheet
      ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id AND sheet.test_request_id=request.id
    JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.id=sheet.latest_submission_id
    JOIN public.template_instances capture ON capture.organization_id=submission.organization_id AND capture.id=submission.instance_id
    WHERE request.organization_id=org AND request.id=run.test_request_id AND submission.id=requested.datasheet_submission_id
      AND capture.status='frozen' AND capture.revision=submission.capture_revision
      AND request.status IN ('under_review','approved') AND sheet.status IN ('under_review','approved')) THEN
    RAISE EXCEPTION 'The submitted result differs from this approval request' USING ERRCODE='23514',CONSTRAINT='workflow_response_result';
  END IF;
  INSERT INTO public.approval_decisions(organization_id,approval_assignment_id,decision,decided_by,comment)
    VALUES(org,p_assignment,'reject',actor,p_comment) RETURNING id INTO recorded_decision;
  INSERT INTO public.approval_decision_checklist_answers(organization_id,decision_id,transition_id,checklist_item_id,is_checked)
    SELECT org,recorded_decision,approval.transition_id,item.id,item.id=ANY(p_checked)
    FROM public.workflow_transition_checklist_items item WHERE item.organization_id=org AND item.transition_id=approval.transition_id;
  UPDATE public.approval_assignments SET status='rejected',responded_at=transaction_timestamp() WHERE organization_id=org AND id=p_assignment;
  UPDATE public.approval_assignments a SET status='cancelled' FROM public.approval_stages s
    WHERE a.organization_id=org AND s.organization_id=org AND a.approval_stage_id=s.id AND s.approval_case_id=approval.id AND a.status='pending';
  UPDATE public.approval_stages SET status='rejected',resolved_at=transaction_timestamp() WHERE organization_id=org AND id=stage.id;
  UPDATE public.approval_stages s SET status='cancelled',resolved_at=transaction_timestamp()
    WHERE s.organization_id=org AND s.approval_case_id=approval.id AND s.status='waiting';
  UPDATE public.workflow_runs r SET revision=r.revision+1 WHERE r.organization_id=org AND r.id=run.id;
  INSERT INTO public.workflow_run_history(organization_id,workflow_run_id,workflow_version_id,from_state_id,to_state_id,transition_id,datasheet_submission_id,action,actor_user_id,comment)
    VALUES(org,run.id,run.workflow_version_id,run.current_state_id,run.current_state_id,approval.transition_id,requested.datasheet_submission_id,'rejected',actor,p_comment)
    RETURNING id INTO recorded_history;
  UPDATE public.approval_cases SET status='rejected',resolved_at=transaction_timestamp(),rejection_history_id=recorded_history
    WHERE organization_id=org AND id=approval.id;
  IF run.sample_id IS NOT NULL THEN
    UPDATE public.samples SET status='rejected',revision=samples.revision+1 WHERE organization_id=org AND id=run.sample_id;
  ELSE
    UPDATE public.test_requests SET status='rejected',revision=test_requests.revision+1 WHERE organization_id=org AND id=run.test_request_id;
    UPDATE public.datasheets SET status='rejected',revision=datasheets.revision+1
      WHERE organization_id=org AND test_request_id=run.test_request_id AND status<>'void';
    PERFORM public.workflow_apply_job_effects(recorded_history);
  END IF;
  RETURN QUERY SELECT run.id,run.revision+1,recorded_history,approval.id,run.current_state_id;
END $$;
REVOKE ALL ON FUNCTION workflow_reject_approval(uuid,text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_reject_approval(uuid,text,uuid[]) TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION workflow_validate_rejection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE approval public.approval_cases; requested public.workflow_run_history; history public.workflow_run_history;
  run public.workflow_runs; decision public.approval_decisions;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='approval_cases' THEN
    IF NEW.status<>'rejected' THEN RETURN NULL; END IF;
    SELECT * INTO approval FROM public.approval_cases WHERE organization_id=NEW.organization_id AND id=NEW.id;
  ELSIF TG_TABLE_NAME='workflow_run_history' THEN
    IF NEW.action<>'rejected' THEN RETURN NULL; END IF;
    SELECT * INTO approval FROM public.approval_cases WHERE organization_id=NEW.organization_id AND rejection_history_id=NEW.id;
  ELSE
    IF NEW.decision<>'reject' THEN RETURN NULL; END IF;
    SELECT c.* INTO approval FROM public.approval_assignments a JOIN public.approval_stages s
      ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
      JOIN public.approval_cases c ON c.organization_id=s.organization_id AND c.id=s.approval_case_id
      WHERE a.organization_id=NEW.organization_id AND a.id=NEW.approval_assignment_id;
  END IF;
  SELECT * INTO requested FROM public.workflow_run_history WHERE organization_id=approval.organization_id AND id=approval.request_history_id;
  SELECT * INTO history FROM public.workflow_run_history WHERE organization_id=approval.organization_id AND id=approval.rejection_history_id;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=approval.organization_id AND id=approval.workflow_run_id;
  SELECT d.* INTO decision FROM public.approval_decisions d JOIN public.approval_assignments a
    ON a.organization_id=d.organization_id AND a.id=d.approval_assignment_id
    JOIN public.approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
    WHERE d.organization_id=approval.organization_id AND s.approval_case_id=approval.id AND d.decision='reject';
  IF approval.id IS NULL OR approval.status<>'rejected' OR history.id IS NULL OR decision.id IS NULL
    OR public.organization_module_scope() IS DISTINCT FROM approval.organization_id OR NOT public.app_has_permission('approvals.respond')
    OR (history.workflow_run_id,history.workflow_version_id,history.transition_id,history.from_state_id,history.to_state_id,history.datasheet_submission_id)
      IS DISTINCT FROM (run.id,approval.workflow_version_id,approval.transition_id,requested.from_state_id,requested.from_state_id,requested.datasheet_submission_id)
    OR history.action<>'rejected' OR history.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR history.actor_user_id IS DISTINCT FROM decision.decided_by OR history.comment IS DISTINCT FROM decision.comment
    OR nullif(trim(decision.comment),'') IS NULL OR approval.resolved_at<>history.occurred_at OR decision.decided_at<>history.occurred_at
    OR history.occurred_at<>transaction_timestamp() OR run.revision<>approval.run_revision+1
    OR run.current_state_id IS DISTINCT FROM requested.from_state_id OR run.status<>'active'
    OR NOT EXISTS (SELECT 1 FROM public.workflow_run_history WHERE organization_id=history.organization_id AND id=history.id AND xmin::text=pg_current_xact_id()::text)
    OR NOT EXISTS (SELECT 1 FROM public.approval_decisions WHERE organization_id=decision.organization_id AND id=decision.id AND xmin::text=pg_current_xact_id()::text)
    OR (SELECT count(*) FROM public.approval_stages WHERE organization_id=approval.organization_id AND approval_case_id=approval.id AND status='rejected')<>1
    OR EXISTS (SELECT 1 FROM public.approval_stages WHERE organization_id=approval.organization_id AND approval_case_id=approval.id AND status IN ('pending','waiting'))
    OR (SELECT count(*) FROM public.approval_decisions d JOIN public.approval_assignments a ON a.organization_id=d.organization_id AND a.id=d.approval_assignment_id
      JOIN public.approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
      WHERE d.organization_id=approval.organization_id AND s.approval_case_id=approval.id AND d.decision='reject')<>1
    OR EXISTS (SELECT 1 FROM public.approval_assignments a JOIN public.approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
      WHERE a.organization_id=approval.organization_id AND s.approval_case_id=approval.id AND a.status='pending')
    OR NOT EXISTS (SELECT 1 FROM public.approval_assignments a JOIN public.approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
      WHERE a.organization_id=approval.organization_id AND a.id=decision.approval_assignment_id AND a.status='rejected'
        AND a.assigned_user_id=decision.decided_by AND a.responded_at=decision.decided_at AND s.status='rejected' AND s.resolved_at=decision.decided_at)
    OR EXISTS (SELECT 1 FROM public.workflow_transition_checklist_items item WHERE item.organization_id=approval.organization_id AND item.transition_id=approval.transition_id
      AND NOT EXISTS (SELECT 1 FROM public.approval_decision_checklist_answers answer WHERE answer.organization_id=item.organization_id AND answer.decision_id=decision.id AND answer.checklist_item_id=item.id)) THEN
    RAISE EXCEPTION 'First rejection, cancellation and actual history must commit together' USING ERRCODE='23514',CONSTRAINT='workflow_rejection_evidence';
  END IF;
  IF (run.sample_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.samples WHERE organization_id=run.organization_id AND id=run.sample_id AND status='rejected'))
    OR (run.test_request_id IS NOT NULL AND (NOT EXISTS (
      SELECT 1 FROM public.test_requests request JOIN public.datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id
      JOIN public.datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.id=sheet.latest_submission_id
      JOIN public.template_instances capture ON capture.organization_id=submission.organization_id AND capture.id=submission.instance_id
      WHERE request.organization_id=run.organization_id AND request.id=run.test_request_id AND request.status='rejected' AND sheet.status='rejected'
        AND submission.id=requested.datasheet_submission_id AND capture.status='frozen' AND capture.revision=submission.capture_revision)
      OR EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=run.organization_id AND test_request_id=run.test_request_id AND status NOT IN ('rejected','void')))) THEN
    RAISE EXCEPTION 'Rejection must preserve its frozen result and update its actual owner' USING ERRCODE='23514',CONSTRAINT='workflow_rejection_owner';
  END IF;
  IF run.test_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.job_submission_members chosen JOIN public.test_requests child
      ON child.organization_id=chosen.organization_id AND child.id=chosen.test_request_id
    WHERE chosen.organization_id=run.organization_id AND chosen.parent_submission_id=requested.datasheet_submission_id
      AND child.parent_test_request_id=run.test_request_id AND child.status<>'approved'
      AND NOT EXISTS (SELECT 1 FROM public.job_workflow_effects effect WHERE effect.organization_id=chosen.organization_id
        AND effect.job_submission_member_id=chosen.id AND effect.parent_history_id=history.id)) THEN
    RAISE EXCEPTION 'Job rejection must record every covered child effect' USING ERRCODE='23514',CONSTRAINT='workflow_rejection_children';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION workflow_validate_rejection() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER approval_rejection_complete AFTER UPDATE ON approval_cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_rejection();
CREATE CONSTRAINT TRIGGER decision_rejection_complete AFTER INSERT ON approval_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_rejection();
CREATE CONSTRAINT TRIGGER history_rejection_complete AFTER INSERT ON workflow_run_history DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_validate_rejection();
--> statement-breakpoint
-- Reuse actual parent effects for only the frozen covered members. Independently
-- approved children retain their approval, as for existing parent transitions.
CREATE OR REPLACE FUNCTION workflow_apply_job_effects(history_id uuid) RETURNS integer
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
    OR parent_history.action NOT IN ('completed','cancelled','approved','transitioned','rejected')
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
    IF parent_history.action='rejected' THEN
      UPDATE public.test_requests SET status='rejected',revision=revision+1 WHERE organization_id=org AND id=member.request_id;
      UPDATE public.datasheets SET status='rejected',revision=revision+1 WHERE organization_id=org AND test_request_id=member.request_id AND status<>'void';
    ELSIF next_status='completed' THEN
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workflow_complete_job_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target_type text; member_request uuid; member_sheet uuid; parent_time timestamptz; parent_action text;
BEGIN
  SELECT target.state_type,chosen.test_request_id,submission.datasheet_id,history.occurred_at,history.action
    INTO target_type,member_request,member_sheet,parent_time,parent_action
    FROM public.job_submission_members chosen JOIN public.datasheet_submissions submission ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id
    JOIN public.workflow_run_history history ON history.organization_id=chosen.organization_id AND history.datasheet_submission_id=chosen.parent_submission_id AND history.id=NEW.parent_history_id
    JOIN public.workflow_states target ON target.organization_id=history.organization_id AND target.id=history.to_state_id
    WHERE chosen.organization_id=NEW.organization_id AND chosen.id=NEW.job_submission_member_id;
  IF member_request IS NULL OR parent_action NOT IN ('completed','cancelled','approved','transitioned','rejected') THEN
    RAISE EXCEPTION 'Job effect does not match its actual parent decision and child submission' USING ERRCODE='23514';
  END IF;
  -- A later transition in the same transaction may supersede the current status.
  IF EXISTS (SELECT 1 FROM public.job_workflow_effects WHERE organization_id=NEW.organization_id
    AND job_submission_member_id=NEW.job_submission_member_id AND parent_run_revision>NEW.parent_run_revision) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.test_requests request JOIN public.datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=member_sheet
      WHERE request.organization_id=NEW.organization_id AND request.id=member_request
        AND ((parent_action='rejected' AND request.status='rejected' AND sheet.status='rejected')
          OR (target_type='final' AND request.status='approved' AND sheet.status='approved' AND request.completed_at=parent_time)
          OR (target_type='cancelled' AND request.status='cancelled' AND sheet.status='void')
          OR (parent_action<>'rejected' AND target_type NOT IN ('final','cancelled') AND request.status='under_review' AND sheet.status='under_review')))
    OR (NEW.child_workflow_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workflow_runs
      WHERE organization_id=NEW.organization_id AND id=NEW.child_workflow_run_id AND test_request_id=member_request
        AND workflow_version_id=NEW.child_workflow_version_id AND current_state_id=NEW.child_state_id AND revision=NEW.child_run_revision+1
        AND status=CASE WHEN target_type='final' THEN 'completed' WHEN target_type='cancelled' THEN 'cancelled' ELSE 'active' END
        AND completed_at IS NOT DISTINCT FROM CASE WHEN target_type IN ('final','cancelled') THEN parent_time ELSE NULL END)) THEN
    RAISE EXCEPTION 'Actual child state changes and parent workflow evidence must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workflow_lock_run(selected_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; run public.workflow_runs;
BEGIN
  IF org IS NULL OR NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute') OR public.app_has_permission('approvals.respond')) THEN
    RAISE EXCEPTION 'Workflow action permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO run FROM public.workflow_runs WHERE organization_id=org AND id=selected_run;
  IF run.id IS NULL THEN RETURN false; END IF;
  IF run.sample_id IS NOT NULL THEN
    PERFORM 1 FROM public.samples WHERE organization_id=org AND id=run.sample_id FOR UPDATE;
  ELSE
    PERFORM public.laboratory_lock_request_sample(run.test_request_id);
    PERFORM 1 FROM public.test_requests WHERE organization_id=org AND id=run.test_request_id FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.workflow_runs WHERE organization_id=org AND id=selected_run FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.laboratory_job_workflow_effects effect
    WHERE effect.organization_id=org AND effect.child_workflow_run_id=selected_run AND effect.is_current
      AND effect.action<>'rejected' AND effect.target_state_type NOT IN ('final','cancelled')) THEN
    RAISE EXCEPTION 'Continue this review from the parent job' USING ERRCODE='23514', CONSTRAINT='workflow_parent_job_controls';
  END IF;
  RETURN true;
END $$;
