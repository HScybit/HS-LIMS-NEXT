-- Registration deliberately clears its temporary context before returning.
-- Deferred job checks use the actual new sample and its generating initial
-- workflow history, so cleanup cannot invalidate a completed registration.
CREATE OR REPLACE FUNCTION laboratory_job_generation_sample(p_sample_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; current_state uuid; generates boolean;
BEGIN
  IF org IS NULL OR actor IS NULL OR p_sample_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.sample_events event WHERE event.organization_id=org AND event.sample_id=p_sample_id
      AND event.event_type='test_requests_generated' AND event.actor_user_id=actor AND event.occurred_at=transaction_timestamp()
      AND event.xmin::text=pg_current_xact_id()::text) THEN RETURN false; END IF;
  IF p_sample_id IS NOT DISTINCT FROM public.workflow_generating_sample() THEN RETURN true; END IF;
  IF public.app_has_permission('samples.create') AND EXISTS (SELECT 1 FROM public.samples sample
    JOIN public.workflow_runs run ON run.organization_id=sample.organization_id AND run.sample_id=sample.id
    JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.action='started'
    JOIN public.workflow_states state ON state.organization_id=history.organization_id AND state.id=history.to_state_id
    WHERE sample.organization_id=org AND sample.id=p_sample_id AND sample.registered_by=actor AND sample.registered_at=transaction_timestamp()
      AND sample.xmin::text=pg_current_xact_id()::text AND history.actor_user_id=actor AND history.occurred_at=transaction_timestamp()
      AND state.state_type='initial' AND state.generate_test_requests) THEN RETURN true; END IF;
  IF NOT (public.app_has_permission('samples.manage') OR public.app_has_permission('test_requests.allocate')) THEN RETURN false; END IF;
  SELECT run.current_state_id,state.generate_test_requests INTO current_state,generates FROM public.workflow_runs run
    JOIN public.workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE run.organization_id=org AND run.sample_id=p_sample_id;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_state_capability_roles WHERE organization_id=org AND workflow_state_id=current_state AND capability='allocate') THEN RETURN true; END IF;
  RETURN coalesce(generates,false) AND EXISTS (SELECT 1 FROM public.workflow_state_capability_roles capability
    JOIN public.membership_roles role ON role.organization_id=capability.organization_id AND role.role_id=capability.role_id
    WHERE capability.organization_id=org AND capability.workflow_state_id=current_state AND capability.capability='allocate' AND role.user_id=actor);
END $$;
