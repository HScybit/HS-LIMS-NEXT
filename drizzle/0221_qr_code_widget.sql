-- Adds qr_code_widget, a read-only context widget (matches PERN's QrCodeWidget) that
-- encodes the report's sample number (falling back to the field's own Title/Key, the
-- same value||label fallback PERN uses) as a QR code. Rendering lives entirely in
-- TemplateCanvas.jsx/qr-code.js — that component is shared by the live report preview
-- and the frozen PDF renderer bundle (see ReportContent.jsx), so no server-only
-- rendering path is needed.
ALTER TABLE template_fields DROP CONSTRAINT template_widget_type;
ALTER TABLE template_fields ADD CONSTRAINT template_widget_type CHECK (
  (widget IN ('text_widget','vertical_text_widget','input_widget','paragraph_widget','sample_details_widget_v2','product_detail_widget',
    'sample_line_item_data_widget','tr_data_widget','decision_rule_widget','tr_result_widget','sno_widget','qr_code_widget') AND value_type='text')
  OR (widget IN ('number_widget','formula_widget') AND value_type='numeric')
  OR (widget='result_widget' AND value_type IN ('numeric','result'))
  OR (widget='checkbox_widget' AND value_type='boolean')
  OR (widget='datepicker_widget' AND value_type='date')
  OR (widget='dropdown_widget' AND value_type='option')
  OR (widget='template_image_widget' AND value_type='image')
  OR (widget='parameter_detail_widget' AND value_type='parameter_detail'));
