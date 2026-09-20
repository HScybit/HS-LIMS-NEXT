-- Creation is one transaction: grouping alone must not produce a usable job
-- or an event claiming successful assignment/capture initialization.
CREATE OR REPLACE FUNCTION laboratory_complete_job_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_count integer; last_position integer; first_position integer; selected_sample uuid;
  job public.test_requests; settings public.organization_laboratory_settings; analyst uuid; sample_state uuid;
BEGIN
  SELECT * INTO job FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=NEW.organization_id FOR SHARE;
  IF job.is_auto_created OR settings.result_summary_template_id IS NULL OR job.datasheet_template_id IS DISTINCT FROM settings.result_summary_template_id THEN
    RAISE EXCEPTION 'Manual jobs require the configured summary template' USING ERRCODE='23514';
  END IF;
  SELECT sample_id INTO selected_sample FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.job_sample_product_id;
  -- Match workflowAllowedActions: a configured allocation capability applies
  -- to this actor; otherwise the allocator permission is the fallback.
  SELECT current_state_id INTO sample_state FROM public.workflow_runs WHERE organization_id=NEW.organization_id AND sample_id=selected_sample;
  IF EXISTS (SELECT 1 FROM public.workflow_state_capability_roles WHERE organization_id=NEW.organization_id AND workflow_state_id=sample_state AND capability='allocate')
    AND NOT EXISTS (SELECT 1 FROM public.workflow_state_capability_roles capability JOIN public.membership_roles role
      ON role.organization_id=capability.organization_id AND role.role_id=capability.role_id
      WHERE capability.organization_id=NEW.organization_id AND capability.workflow_state_id=sample_state AND capability.capability='allocate' AND role.user_id=NEW.created_by)
  THEN RAISE EXCEPTION 'The sample state does not allow this actor to create jobs' USING ERRCODE='42501'; END IF;
  SELECT assigned_user_id INTO analyst FROM public.test_request_assignments
    WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND assignment_type='analyst' AND unassigned_at IS NULL
      AND assigned_by=NEW.created_by AND assigned_at=transaction_timestamp();
  IF job.status<>'allocated' OR analyst IS NULL OR NOT EXISTS (SELECT 1 FROM public.datasheets
    WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND attempt_number=1 AND status='in_progress')
  THEN RAISE EXCEPTION 'A manual job requires its actual analyst and summary capture' USING ERRCODE='23514'; END IF;
  SELECT count(*)::integer,min(job_member_position),max(job_member_position) INTO member_count,first_position,last_position
    FROM public.test_requests WHERE organization_id=NEW.organization_id AND parent_test_request_id=NEW.id;
  IF member_count=0 OR first_position<>0 OR last_position<>member_count-1 THEN
    RAISE EXCEPTION 'A job requires an ordered set of linked requests' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.test_requests member WHERE member.organization_id=NEW.organization_id AND member.parent_test_request_id=NEW.id
    AND (member.status<>'allocated' OR NOT EXISTS (SELECT 1 FROM public.test_request_assignments assignment
      WHERE assignment.organization_id=member.organization_id AND assignment.test_request_id=member.id AND assignment.assignment_type='analyst'
        AND assignment.assigned_user_id=analyst AND assignment.unassigned_at IS NULL AND assignment.assigned_by=NEW.created_by AND assignment.assigned_at=transaction_timestamp())
      OR NOT EXISTS (SELECT 1 FROM public.datasheets sheet WHERE sheet.organization_id=member.organization_id AND sheet.test_request_id=member.id AND sheet.attempt_number=1 AND sheet.status='in_progress')))
  THEN RAISE EXCEPTION 'Job members require their actual analyst and individual captures' USING ERRCODE='23514'; END IF;
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    VALUES(NEW.organization_id,selected_sample,NEW.id,'test_request_job_created',NEW.created_by,
      format('Created job with %s test request%s.',member_count,CASE WHEN member_count=1 THEN '' ELSE 's' END));
  RETURN NEW;
END $$;
