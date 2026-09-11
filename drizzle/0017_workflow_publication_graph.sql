ALTER TABLE workflow_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_transition_read ON workflow_transitions FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND
    (SELECT laboratory_can_read() OR app_has_permission('workflows.read') OR app_has_permission('workflows.manage')));
CREATE POLICY workflow_transition_write ON workflow_transitions FOR ALL TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('workflows.manage')))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('workflows.manage')));
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_transitions TO sampleify_app;
CREATE TRIGGER laboratory_transition_identity_guard BEFORE UPDATE ON workflow_transitions FOR EACH ROW EXECUTE FUNCTION laboratory_guard_identity();

CREATE FUNCTION laboratory_guard_workflow_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org uuid; ver uuid; state text;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; ver := OLD.workflow_version_id;
  ELSE org := NEW.organization_id; ver := NEW.workflow_version_id; END IF;
  IF TG_OP = 'UPDATE' AND NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id THEN
    RAISE EXCEPTION 'Workflow transition ownership is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO state FROM public.workflow_versions WHERE organization_id = org AND id = ver FOR UPDATE;
  IF state IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only draft workflow transitions may change' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_workflow_transition_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_transitions
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_workflow_transition();

-- Match source publication requirements, including its final state and outgoing
-- edge checks. Existing historical records are not rewritten by this migration.
CREATE FUNCTION laboratory_guard_workflow_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status = 'published' AND OLD.status = 'draft' THEN
    IF (SELECT count(*) FROM public.workflow_states WHERE organization_id = NEW.organization_id AND workflow_version_id = NEW.id AND state_type = 'final') <> 1 THEN
      RAISE EXCEPTION 'Published workflow requires exactly one final state' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.workflow_states s WHERE s.organization_id = NEW.organization_id AND s.workflow_version_id = NEW.id
      AND s.state_type IN ('initial', 'normal') AND NOT EXISTS (SELECT 1 FROM public.workflow_transitions t
        WHERE t.organization_id = s.organization_id AND t.workflow_version_id = s.workflow_version_id AND t.source_state_id = s.id)) THEN
      RAISE EXCEPTION 'Every initial or normal state requires an outgoing transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_workflow_publication_guard BEFORE UPDATE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION laboratory_guard_workflow_publication();
