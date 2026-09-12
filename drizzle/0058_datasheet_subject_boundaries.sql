ALTER TABLE datasheet_subjects ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON datasheet_subjects TO sampleify_app;
GRANT SELECT ON datasheet_subjects TO sampleify_report_worker;
CREATE POLICY datasheet_subject_read ON datasheet_subjects FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT public.laboratory_can_read()));
CREATE POLICY datasheet_subject_insert ON datasheet_subjects FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND instance_id=nullif(current_setting('app.capture_id',true),'')::uuid
    AND (public.app_has_permission('test_requests.allocate') OR public.laboratory_capture_can_write()));
CREATE POLICY report_worker_read ON datasheet_subjects FOR SELECT TO sampleify_report_worker USING (organization_id=(SELECT public.report_pdf_context_org()));

CREATE FUNCTION laboratory_guard_datasheet_subject() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sheet public.datasheets; owner public.test_requests; subject public.test_requests; occurrence public.template_occurrences;
  capture public.template_instances; repeat_source text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Parameter subject history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO sheet FROM public.datasheets WHERE organization_id=NEW.organization_id AND id=NEW.datasheet_id;
  SELECT * INTO owner FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=sheet.test_request_id;
  SELECT * INTO subject FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.test_request_id;
  SELECT * INTO capture FROM public.template_instances WHERE organization_id=NEW.organization_id AND id=NEW.instance_id FOR UPDATE;
  SELECT * INTO occurrence FROM public.template_occurrences WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND version_id=NEW.version_id AND id=NEW.occurrence_id;
  SELECT source INTO repeat_source FROM public.template_repeat_groups WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=occurrence.group_id;
  IF sheet.id IS NULL OR subject.id IS NULL OR capture.status IS DISTINCT FROM 'editing' OR sheet.template_instance_id<>NEW.instance_id
    OR repeat_source IS DISTINCT FROM 'test_requests' OR occurrence.removed_revision IS NOT NULL
    OR NEW.created_revision IS DISTINCT FROM occurrence.created_revision OR NEW.created_revision<>capture.revision
    OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
  THEN RAISE EXCEPTION 'Parameter subjects require their current capture, actor and occurrence' USING ERRCODE='23514'; END IF;
  IF owner.is_job THEN
    IF subject.is_job OR subject.parent_test_request_id IS DISTINCT FROM owner.id OR NEW.specification_id<>subject.specification_id THEN
      RAISE EXCEPTION 'Job parameter subjects must use a member and its frozen specification' USING ERRCODE='23514';
    END IF;
  ELSIF subject.id<>owner.id OR NEW.specification_id IS DISTINCT FROM sheet.specification_id THEN
    RAISE EXCEPTION 'An individual datasheet must use its own frozen specification' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.datasheet_subjects binding JOIN public.template_occurrences other
    ON other.organization_id=binding.organization_id AND other.instance_id=binding.instance_id AND other.id=binding.occurrence_id
    WHERE binding.organization_id=NEW.organization_id AND binding.instance_id=NEW.instance_id AND binding.test_request_id=NEW.test_request_id
      AND other.group_id=occurrence.group_id AND other.parent_id=occurrence.parent_id AND other.removed_revision IS NULL)
  THEN RAISE EXCEPTION 'Each parameter occurs once within its parent loop' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER datasheet_subject_guard BEFORE INSERT OR UPDATE OR DELETE ON datasheet_subjects FOR EACH ROW EXECUTE FUNCTION laboratory_guard_datasheet_subject();

CREATE FUNCTION laboratory_complete_subject_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE repeat_source text;
BEGIN
  SELECT source INTO repeat_source FROM public.template_repeat_groups WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND id=NEW.group_id;
  IF repeat_source IS DISTINCT FROM 'test_requests' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.datasheet_subjects WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND occurrence_id=NEW.id) THEN
    RAISE EXCEPTION 'A parameter occurrence requires its recorded request subject' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.removed_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.template_occurrences
    WHERE organization_id=NEW.organization_id AND instance_id=NEW.instance_id AND id=NEW.parent_id AND removed_revision=NEW.removed_revision)
  THEN RAISE EXCEPTION 'A parameter occurrence cannot be removed independently of its parent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER datasheet_subject_occurrence_complete AFTER INSERT OR UPDATE ON template_occurrences DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.group_id IS NOT NULL) EXECUTE FUNCTION laboratory_complete_subject_occurrence();

CREATE FUNCTION laboratory_complete_capture_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sheet public.datasheets; owner public.test_requests; allowed_subjects uuid[]; inconsistent boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.template_repeat_groups WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id AND source='test_requests') THEN RETURN NEW; END IF;
  SELECT * INTO sheet FROM public.datasheets WHERE organization_id=NEW.organization_id AND template_instance_id=NEW.id;
  SELECT * INTO owner FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=sheet.test_request_id;
  IF sheet.id IS NULL THEN RAISE EXCEPTION 'Parameter loops require a real datasheet owner' USING ERRCODE='23514'; END IF;
  IF owner.is_job THEN
    SELECT array_agg(id ORDER BY job_member_position) INTO allowed_subjects FROM public.test_requests WHERE organization_id=NEW.organization_id AND parent_test_request_id=owner.id;
  ELSE allowed_subjects:=ARRAY[owner.id]; END IF;
  IF coalesce(cardinality(allowed_subjects),0)=0 THEN RAISE EXCEPTION 'Parameter loops require at least one request subject' USING ERRCODE='23514'; END IF;
  WITH RECURSIVE active_occurrences AS MATERIALIZED (
    SELECT occurrence.id,occurrence.parent_id,occurrence.group_id,binding.test_request_id AS own_subject
    FROM public.template_occurrences occurrence LEFT JOIN public.datasheet_subjects binding
      ON binding.organization_id=occurrence.organization_id AND binding.instance_id=occurrence.instance_id AND binding.occurrence_id=occurrence.id
    WHERE occurrence.organization_id=NEW.organization_id AND occurrence.instance_id=NEW.id AND occurrence.removed_revision IS NULL
  ), ancestry AS (
    SELECT id,parent_id,group_id,own_subject AS subject FROM active_occurrences WHERE group_id IS NULL
    UNION ALL SELECT child.id,child.parent_id,child.group_id,coalesce(child.own_subject,parent.subject)
      FROM active_occurrences child JOIN ancestry parent ON parent.id=child.parent_id
  ), counts AS (
    SELECT child.parent_id,child.group_id,count(*) AS total,
      bool_and(CASE WHEN parent.subject IS NULL THEN child.subject=ANY(allowed_subjects) ELSE child.subject=parent.subject END) AS valid
      FROM ancestry child JOIN ancestry parent ON parent.id=child.parent_id GROUP BY child.parent_id,child.group_id
  ) SELECT EXISTS(SELECT 1 FROM ancestry parent JOIN public.template_repeat_groups definition
      ON definition.organization_id=NEW.organization_id AND definition.version_id=NEW.version_id AND definition.source='test_requests'
        AND definition.parent_group_id IS NOT DISTINCT FROM parent.group_id
      LEFT JOIN counts ON counts.parent_id=parent.id AND counts.group_id=definition.id
      WHERE coalesce(counts.total,0)<>CASE WHEN parent.subject IS NULL THEN cardinality(allowed_subjects) ELSE 1 END OR counts.valid IS DISTINCT FROM true)
    INTO inconsistent;
  IF inconsistent THEN RAISE EXCEPTION 'Parameter loops must contain their exact request subjects' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER datasheet_capture_subjects_complete AFTER INSERT OR UPDATE ON template_instances DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laboratory_complete_capture_subjects();
