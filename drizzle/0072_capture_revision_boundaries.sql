-- Record new revisions only. Backfilling earlier actors/transaction IDs would
-- invent evidence; existing captures acquire a record on their next real edit.
ALTER TABLE template_capture_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY capture_revision_read ON template_capture_revisions FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM template_instances capture WHERE capture.organization_id=template_capture_revisions.organization_id
      AND capture.id=template_capture_revisions.instance_id));
GRANT SELECT ON template_capture_revisions TO sampleify_app;
CREATE TRIGGER capture_revision_append_only BEFORE UPDATE OR DELETE ON template_capture_revisions
  FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

CREATE FUNCTION template_record_capture_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.template_capture_revisions(organization_id,instance_id,revision,status,transaction_id,recorded_by,database_role,recorded_at)
    VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.status,pg_current_xact_id(),
      nullif(current_setting('app.user_id',true),'')::uuid,session_user,transaction_timestamp());
  RETURN NULL;
END $$;
CREATE TRIGGER capture_revision_record AFTER INSERT OR UPDATE ON template_instances
  FOR EACH ROW EXECUTE FUNCTION template_record_capture_revision();

-- Use a full transaction ID stored in immutable evidence, rather than the
-- 32-bit xmin system column, whose representation can change after vacuum.
CREATE FUNCTION template_require_current_capture_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_revision integer;
BEGIN
  IF TG_TABLE_NAME='template_values' THEN selected_revision:=NEW.revision;
  ELSIF TG_OP='INSERT' THEN selected_revision:=NEW.created_revision;
  ELSE selected_revision:=NEW.removed_revision;
  END IF;
  IF session_user='sampleify_app' AND NOT EXISTS (
    SELECT 1 FROM public.template_capture_revisions revision
    WHERE revision.organization_id=NEW.organization_id AND revision.instance_id=NEW.instance_id
      AND revision.revision=selected_revision AND revision.status='editing' AND revision.transaction_id=pg_current_xact_id()
      AND revision.recorded_by=nullif(current_setting('app.user_id',true),'')::uuid
  ) THEN RAISE EXCEPTION 'Capture changes must belong to a revision created by this transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_value_revision_guard BEFORE INSERT ON template_values
  FOR EACH ROW EXECUTE FUNCTION template_require_current_capture_revision();
CREATE TRIGGER capture_occurrence_revision_guard BEFORE INSERT OR UPDATE ON template_occurrences
  FOR EACH ROW EXECUTE FUNCTION template_require_current_capture_revision();
