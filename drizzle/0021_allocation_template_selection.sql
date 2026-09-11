-- A request without a rule template selects its category default on first
-- allocation, as in the source. Once selected, the template cannot be replaced.
CREATE OR REPLACE FUNCTION laboratory_guard_test_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE specification public.analytical_specifications; selected public.sample_tests;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.sample_test_id, NEW.specification_id, NEW.request_number, NEW.parent_test_request_id, NEW.attempt_number, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.sample_test_id, OLD.specification_id, OLD.request_number, OLD.parent_test_request_id, OLD.attempt_number, OLD.created_by, OLD.created_at)
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Test request identity is immutable and revisions are sequential' USING ERRCODE = '23514'; END IF;
    IF NEW.datasheet_template_id IS DISTINCT FROM OLD.datasheet_template_id AND
      (OLD.datasheet_template_id IS NOT NULL OR NEW.datasheet_template_id IS NULL
        OR NOT public.app_has_permission('test_requests.allocate')
        OR NOT EXISTS (SELECT 1 FROM public.datasheets d JOIN public.template_instances i
          ON i.organization_id = d.organization_id AND i.id = d.template_instance_id
          JOIN public.template_versions v ON v.organization_id = i.organization_id AND v.id = i.version_id
          WHERE d.organization_id = NEW.organization_id AND d.test_request_id = NEW.id
            AND d.attempt_number = 1 AND v.template_id = NEW.datasheet_template_id)) THEN
      RAISE EXCEPTION 'A request template can only be selected during its first allocation' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.status <> 'created' OR NEW.revision <> 1 THEN RAISE EXCEPTION 'Test requests start as created records' USING ERRCODE = '23514'; END IF;
    SELECT * INTO specification FROM public.analytical_specifications WHERE organization_id = NEW.organization_id AND id = NEW.specification_id FOR SHARE;
    SELECT * INTO selected FROM public.sample_tests WHERE organization_id = NEW.organization_id AND id = NEW.sample_test_id;
    IF specification.id IS NULL OR selected.id IS NULL OR (specification.test_parameter_id, specification.method_id, specification.decision_rule_id)
      IS DISTINCT FROM (selected.test_parameter_id, selected.method_id, selected.decision_rule_id) THEN
      RAISE EXCEPTION 'Analytical specification does not match the selected test' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
