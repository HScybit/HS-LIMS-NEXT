-- A maximum upload has625,000 cells. Validate their immutable input parents once
-- per insertion statement; the two relational foreign keys remain in force.
CREATE FUNCTION master_bulk_guard_inserted_cells() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF actor IS NULL OR org IS NULL OR NOT public.app_has_permission('masters.manage')
    OR EXISTS (SELECT 1 FROM inserted_master_bulk_cells WHERE organization_id IS DISTINCT FROM org) THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT organization_id,batch_id,row_id,revision FROM inserted_master_bulk_cells) inserted
    LEFT JOIN public.master_bulk_row_versions parent ON parent.organization_id=inserted.organization_id AND parent.batch_id=inserted.batch_id
      AND parent.row_id=inserted.row_id AND parent.revision=inserted.revision
    WHERE parent.created_transaction_id IS DISTINCT FROM pg_current_xact_id() OR parent.saved_by IS DISTINCT FROM actor
  ) THEN RAISE EXCEPTION 'Input cells require the actual actor and an uncommitted input revision' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION master_bulk_guard_inserted_cells() FROM PUBLIC,sampleify_app,sampleify_report_worker;
DROP TRIGGER master_bulk_input_guard ON master_bulk_cells;
CREATE TRIGGER master_bulk_input_guard BEFORE UPDATE OR DELETE ON master_bulk_cells FOR EACH ROW EXECUTE FUNCTION master_bulk_guard();
CREATE TRIGGER master_bulk_cell_insert_guard AFTER INSERT ON master_bulk_cells REFERENCING NEW TABLE AS inserted_master_bulk_cells
  FOR EACH STATEMENT EXECUTE FUNCTION master_bulk_guard_inserted_cells();
