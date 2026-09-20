-- Template Studio parity, Phase 4 (live collaboration): every editTemplate command already
-- bumps template_versions.revision exactly once via nextRevision(), regardless of how many
-- child rows it touches — so a single AFTER UPDATE trigger on that one column is sufficient
-- to notify every definition change, without attaching a trigger to each of the ~10 child
-- definition tables individually.
CREATE FUNCTION template_notify_version_change() RETURNS trigger AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    PERFORM pg_notify('template_designer_events', json_build_object(
      'organizationId', NEW.organization_id,
      'templateId', NEW.template_id,
      'templateVersionId', NEW.id,
      'revision', NEW.revision
    )::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_version_notify AFTER UPDATE ON template_versions FOR EACH ROW EXECUTE FUNCTION template_notify_version_change();
