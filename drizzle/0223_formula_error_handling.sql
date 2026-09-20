-- Template Studio parity, Phase 1 (schema/backend): formula_widget gains PERN's
-- onMissingValue/onError knobs, but with backward-compatible defaults ('error'/
-- 'show_error') that match this app's existing, already-shipped behavior exactly
-- for every formula field authored before this migration: evaluateExpression()
-- already fails fast with 'expression_missing' the instant any scalar reference
-- resolves to no value, so 'error' (not PERN's own default) is what "unchanged"
-- actually means here. roundingMode is intentionally not ported: this app stores
-- the full-precision computed value and only formats it for display (displayScale/
-- padDecimals), whereas PERN rounds the stored value itself, so there is no
-- equivalent "stored precision" knob to add here.
ALTER TABLE template_fields ADD COLUMN formula_on_missing_value text NOT NULL DEFAULT 'error';
ALTER TABLE template_fields ADD COLUMN formula_on_error text NOT NULL DEFAULT 'show_error';
ALTER TABLE template_fields ADD CONSTRAINT template_formula_error_handling CHECK (
  formula_on_missing_value IN ('zero','blank','error') AND formula_on_error IN ('show_error','blank')
  AND (widget='formula_widget' OR (formula_on_missing_value='error' AND formula_on_error='show_error')));
