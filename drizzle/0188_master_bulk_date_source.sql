-- Excel's decoder records Date cells explicitly, alongside their typed instant.
-- Retain that provenance without changing the value or reference constraints.
ALTER TABLE master_bulk_cells DROP CONSTRAINT master_bulk_cell_source;
ALTER TABLE master_bulk_cells ADD CONSTRAINT master_bulk_cell_source CHECK (
  (source_type IS NULL OR source_type IN ('formula','error','hyperlink','rich_text','formatted','date'))
  AND (formula IS NULL OR length(formula)<=16000) AND (error_code IS NULL OR length(error_code)<=16000)
  AND (hyperlink IS NULL OR length(hyperlink)<=16000) AND (number_format IS NULL OR length(number_format)<=16000));
