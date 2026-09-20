ALTER TABLE "workflow_states" ADD COLUMN "canvas_x" integer;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "canvas_y" integer;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "input_count" integer;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "output_count" integer;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "badge_style" text;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD COLUMN "source_port" integer;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD COLUMN "target_port" integer;--> statement-breakpoint
CREATE INDEX "workflow_transition_source" ON "workflow_transitions" USING btree ("organization_id","workflow_version_id","source_state_id");--> statement-breakpoint
CREATE INDEX "workflow_transition_target" ON "workflow_transitions" USING btree ("organization_id","workflow_version_id","target_state_id");--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_state_layout" CHECK (("workflow_states"."canvas_x" is null or "workflow_states"."canvas_x" between 0 and 100000) and ("workflow_states"."canvas_y" is null or "workflow_states"."canvas_y" between 0 and 100000)
    and ("workflow_states"."input_count" is null or "workflow_states"."input_count" between 0 and 8) and ("workflow_states"."output_count" is null or "workflow_states"."output_count" between 0 and 8)
    and ("workflow_states"."badge_style" is null or "workflow_states"."badge_style" in ('light','dark')));--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transition_ports" CHECK (("workflow_transitions"."source_port" is null or "workflow_transitions"."source_port" between 1 and 8) and ("workflow_transitions"."target_port" is null or "workflow_transitions"."target_port" between 1 and 8));
--> statement-breakpoint
-- NULL marks layout that earlier definitions did not record. Their implicit
-- connection uses port one, without backfilling an invented historical value.
-- Existing definition guards serialize edits through the draft version lock.
CREATE FUNCTION workflow_validate_ports() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.workflow_transitions connection
    JOIN public.workflow_states source ON source.organization_id=connection.organization_id AND source.id=connection.source_state_id
    JOIN public.workflow_states target ON target.organization_id=connection.organization_id AND target.id=connection.target_state_id
    WHERE connection.organization_id=NEW.organization_id AND connection.workflow_version_id=NEW.workflow_version_id
      AND ((TG_TABLE_NAME='workflow_states' AND (connection.source_state_id=NEW.id OR connection.target_state_id=NEW.id))
        OR (TG_TABLE_NAME='workflow_transitions' AND connection.id=NEW.id))
      AND (coalesce(connection.source_port,1)>coalesce(source.output_count,1) OR coalesce(connection.target_port,1)>coalesce(target.input_count,1))
  ) THEN
    RAISE EXCEPTION 'Workflow connections require available source and target ports'
      USING ERRCODE='23514',CONSTRAINT='workflow_connection_port';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION workflow_validate_ports() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER workflow_state_port_links AFTER INSERT OR UPDATE ON workflow_states
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_validate_ports();
CREATE CONSTRAINT TRIGGER workflow_transition_port_links AFTER INSERT OR UPDATE ON workflow_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_validate_ports();
