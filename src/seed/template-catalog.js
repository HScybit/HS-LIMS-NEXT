/**
 * Template masters, ported from PERN's `templateV3Catalog.js`: the Analytical
 * Datasheet, the Certificate of Analysis and the Instrument Service Record.
 *
 * The section, row and column structure, the labels, the grid spans, the CSS
 * classes and the parameter loop are all as V4 writes them. Three of V4's
 * widget types have no equivalent in this template engine, and each is mapped
 * to the closest widget that keeps the field usable:
 *
 *   state_transition_widget   -> input_widget. V4 fills "Reviewed By" and
 *     "Approved On" from the workflow transition that granted them; here they
 *     are recorded on the sheet.
 *   dependent_dropdown_widget -> dropdown_widget. V4 cascades through a Data
 *     Master's levels; our lookup sources are flat, so each field offers that
 *     level's values directly.
 *   sample_details_widget_v2 with a project-field source (batch number, AR
 *     number, manufacturing and expiry dates, environment readings, release
 *     date) -> input_widget, because our sample details widget reads only the
 *     ten built-in domain fields.
 */
import { DATA_MASTERS } from './shared-catalog.js';

const LABEL_CELL = 'border px-2 py-1 fw-bold bg-light';
const VALUE_CELL = 'border px-2 py-1';
const HEAD_CELL = 'border px-2 py-1 fw-bold bg-light text-center';
const DATA_CELL = 'border px-2 py-1 text-center';

// Source fields our sample details widget can actually read.
const SAMPLE_SOURCE_FIELDS = new Set(['sampleNumber', 'customerName', 'customerAddress', 'sampleCategoryName',
  'productName', 'receivedAt', 'registeredAt', 'dueAt', 'description', 'customerReference']);

const cell = (key, widget, span, options = {}) => ({ key, widget, span, ...options });

const text = (key, content, span = 3, className = LABEL_CELL) =>
  cell(key, 'text_widget', span, { label: content, defaultText: content, className: `col-${span} ${className}` });

const label = (key, content, span = 3) => text(key, content, span, LABEL_CELL);
const heading = (key, content, span) => text(key, content, span, HEAD_CELL);
const title = (key, content) => cell(key, 'text_widget', 12, {
  label: content, defaultText: content, className: 'col-12 text-center fw-bold border px-2 py-2',
});

// A sample attribute the widget can read, or a recorded field when it cannot.
const sampleField = (key, sourceField, span = 3, className = VALUE_CELL) => (SAMPLE_SOURCE_FIELDS.has(sourceField)
  ? cell(key, 'sample_details_widget_v2', span, { sourceField, className: `col-${span} ${className}` })
  : cell(key, 'input_widget', span, { className: `col-${span} ${className}`, placeholder: sourceField, editable: true }));

const requestField = (key, sourceField, span, className = DATA_CELL) =>
  cell(key, 'tr_data_widget', span, { sourceField, className: `col-${span} ${className}` });

const ruleField = (key, sourceField, span) =>
  cell(key, 'decision_rule_widget', span, { sourceField, className: `col-${span} ${DATA_CELL}` });

const entry = (key, placeholder, span, className = VALUE_CELL, extra = {}) =>
  cell(key, 'input_widget', span, { placeholder, className: `col-${span} ${className}`, editable: true, ...extra });

// V4 fills these from the workflow transition that granted them.
const transitionField = (key, placeholder, span = 3) => entry(key, placeholder, span, VALUE_CELL);

// V4 cascades through the master's levels; each level is offered on its own.
function dataMasterField(key, masterRef, depth, span = 3) {
  const master = DATA_MASTERS.find((candidate) => candidate.ref === masterRef);
  const byRef = Object.fromEntries((master?.items ?? []).map((item) => [item.ref, item]));
  const depthOf = (item) => { let level = 0; let parent = item.parent; while (parent && byRef[parent]) { level += 1; parent = byRef[parent].parent; } return level; };
  const options = (master?.items ?? []).filter((item) => depthOf(item) === depth).map((item) => item.name);
  return cell(key, 'dropdown_widget', span, { className: `col-${span} ${VALUE_CELL}`, options, editable: true });
}

const analyticalDatasheet = {
  code: 'STD-ANALYTICAL-DATASHEET',
  name: 'Analytical Datasheet',
  description: 'Datasheet used to record analytical results for a test request.',
  kind: 'datasheet',
  sections: [
    { name: 'Datasheet Details', className: 'ds-details border', rows: [
      [title('ds_title', 'ANALYTICAL DATASHEET')],
      [label('ds_sample_id_label', 'Sample ID'), sampleField('ds_sample_id', 'sampleNumber'), label('ds_batch_number_label', 'Batch Number'), sampleField('ds_batch_number', 'batch_number')],
      [label('ds_product_label', 'Product'), sampleField('ds_product', 'productName'), label('ds_category_label', 'Sample Category'), sampleField('ds_category', 'sampleCategoryName')],
      [label('ds_customer_label', 'Customer'), sampleField('ds_customer', 'customerName'), label('ds_registered_on_label', 'Registered On'), sampleField('ds_registered_on', 'registeredAt')],
      [label('ds_request_label', 'Test Request'), requestField('ds_request', 'requestNumber', 3, VALUE_CELL), label('ds_analyst_label', 'Analyst'), requestField('ds_analyst', 'analystName', 3, VALUE_CELL)],
    ] },
    { name: 'Sampling and Storage Conditions', className: 'ds-conditions border', rows: [
      [label('ds_loc_site_label', 'Site'), dataMasterField('ds_loc_site', 'dm_sampling_location', 0), label('ds_loc_block_label', 'Block'), dataMasterField('ds_loc_block', 'dm_sampling_location', 1)],
      [label('ds_loc_room_label', 'Room'), dataMasterField('ds_loc_room', 'dm_sampling_location', 2), label('ds_storage_group_label', 'Storage Regime'), dataMasterField('ds_storage_group', 'dm_storage_condition', 0)],
      [label('ds_storage_detail_label', 'Storage Condition'), dataMasterField('ds_storage_detail', 'dm_storage_condition', 1), label('ds_env_temp_label', 'Temperature At Analysis'), sampleField('ds_env_temp', 'environmentTemperature')],
      [label('ds_env_humidity_label', 'Humidity At Analysis'), sampleField('ds_env_humidity', 'environmentHumidity'), label('ds_receipt_condition_label', 'Condition On Receipt'), dataMasterField('ds_receipt_condition', 'dm_sample_condition', 0)],
    ] },
    { name: 'Analytical Results Heading', className: 'ds-results-heading border', isParameterLoopHeader: true, rows: [
      [heading('ds_head_sno', 'S. No.', 1), heading('ds_head_parameter', 'Test Parameter', 2), heading('ds_head_specification', 'Specification', 2),
        heading('ds_head_method', 'Method of Analysis', 2), heading('ds_head_result', 'Observed Result', 2), heading('ds_head_unit', 'Unit', 1), heading('ds_head_status', 'Status', 2)],
    ] },
    { name: 'Analytical Results', className: 'ds-results border', isParameterLoop: true, repeat: { minimum: 1, maximum: 100 }, rows: [
      [cell('ds_result_sno', 'sno_widget', 1, { className: `col-1 ${DATA_CELL}`, serialPadding: 2 }),
        requestField('ds_result_parameter', 'parameterName', 2),
        ruleField('ds_result_specification', 'specification', 2),
        requestField('ds_result_method', 'methodName', 2),
        cell('ds_observed_result', 'result_widget', 2, { label: 'Observed Result', placeholder: 'Observed value', className: `col-2 ${DATA_CELL}`, required: true, isFinalResult: true, editable: true }),
        ruleField('ds_result_unit', 'measurementUnit', 1),
        entry('ds_result_status', 'Pass / Fail', 2, DATA_CELL)],
    ] },
    { name: 'Analyst Declaration', className: 'ds-declaration border', rows: [
      [label('ds_analysed_by_label', 'Analysed By'), requestField('ds_analysed_by', 'analystName', 3, VALUE_CELL), label('ds_submitted_on_label', 'Submitted On'), requestField('ds_submitted_on', 'submittedAt', 3, VALUE_CELL)],
      [label('ds_reviewed_by_label', 'Reviewed By'), transitionField('ds_reviewed_by', 'Reviewer'), label('ds_reviewed_on_label', 'Reviewed On'), transitionField('ds_reviewed_on', 'Review date')],
      [label('ds_approved_by_label', 'Approved By'), transitionField('ds_approved_by', 'Approver'), label('ds_approved_on_label', 'Approved On'), transitionField('ds_approved_on', 'Approval date')],
      [label('ds_remarks_label', 'Remarks'), entry('analyst_remarks', 'Observations', 9)],
    ] },
  ],
};

const certificateOfAnalysis = {
  code: 'STD-CERTIFICATE-OF-ANALYSIS',
  name: 'Certificate of Analysis',
  description: 'Certificate of analysis issued for a released sample.',
  kind: 'report',
  templateType: 'sample_coa',
  sections: [
    { name: 'Certificate Heading', className: 'coa-heading', rows: [[title('coa_title', 'CERTIFICATE OF ANALYSIS')]] },
    { name: 'Certificate Details', className: 'coa-details border', rows: [
      [label('coa_product_label', 'Product Name'), sampleField('coa_product', 'productName'), label('coa_sample_id_label', 'Sample Number'), sampleField('coa_sample_id', 'sampleNumber')],
      [label('coa_batch_number_label', 'Batch Number'), sampleField('coa_batch_number', 'batch_number'), label('coa_ar_number_label', 'AR Number'), sampleField('coa_ar_number', 'ar_number')],
      [label('coa_mfg_date_label', 'Manufacturing Date'), sampleField('coa_mfg_date', 'manufacturing_date'), label('coa_exp_date_label', 'Expiry Date'), sampleField('coa_exp_date', 'expiry_date')],
      [label('coa_customer_label', 'Customer'), sampleField('coa_customer', 'customerName'), label('coa_category_label', 'Sample Category'), sampleField('coa_category', 'sampleCategoryName')],
      [label('coa_storage_group_label', 'Storage Regime'), dataMasterField('coa_storage_group', 'dm_storage_condition', 0), label('coa_storage_detail_label', 'Storage Condition'), dataMasterField('coa_storage_detail', 'dm_storage_condition', 1)],
      [label('coa_env_temp_label', 'Temperature At Analysis'), sampleField('coa_env_temp', 'environmentTemperature'), label('coa_env_humidity_label', 'Humidity At Analysis'), sampleField('coa_env_humidity', 'environmentHumidity')],
    ] },
    { name: 'Test Results Heading', className: 'coa-results-heading border', isParameterLoopHeader: true, rows: [
      [heading('coa_head_sno', 'S. No.', 1), heading('coa_head_parameter', 'Test Parameter', 3), heading('coa_head_specification', 'Specification', 2),
        heading('coa_head_method', 'Method', 2), heading('coa_head_result', 'Result', 2), heading('coa_head_unit', 'Unit', 1), heading('coa_head_status', 'Status', 1)],
    ] },
    { name: 'Test Results', className: 'coa-results border', isParameterLoop: true, repeat: { minimum: 1, maximum: 100 }, rows: [
      [cell('coa_result_sno', 'sno_widget', 1, { className: `col-1 ${DATA_CELL}`, serialPadding: 2 }),
        requestField('coa_result_parameter', 'parameterName', 3),
        ruleField('coa_result_specification', 'specification', 2),
        requestField('coa_result_method', 'methodName', 2),
        cell('coa_result', 'tr_result_widget', 2, { label: 'Result', className: `col-2 ${DATA_CELL}` }),
        ruleField('coa_result_unit', 'measurementUnit', 1),
        text('coa_status', 'Complies', 1, DATA_CELL)],
    ] },
    { name: 'Conclusion', className: 'coa-conclusion border', rows: [
      [cell('coa_conclusion', 'text_widget', 12, { label: 'Conclusion', defaultText: 'The sample complies with the specification for the parameters tested.', className: 'col-12 px-2 py-2' })],
      [label('coa_approved_by_label', 'Approved By'), transitionField('coa_approved_by', 'Approver'), label('coa_approved_on_label', 'Approved On'), transitionField('coa_approved_on', 'Approval date')],
      [label('coa_signature_label', 'Signature'), transitionField('coa_signature', 'Signature'), label('coa_released_on_label', 'Released On'), sampleField('coa_released_on', 'releasedAt')],
    ] },
  ],
};

const instrumentServiceRecord = {
  code: 'STD-INSTRUMENT-SERVICE-RECORD',
  name: 'Instrument Service Record',
  description: 'Record completed against an instrument calibration or maintenance.',
  kind: 'equipment_service_log',
  associateWithSampleCategories: false,
  sections: [
    { name: 'Service Record', className: 'svc-details border', rows: [
      [title('svc_title', 'INSTRUMENT SERVICE RECORD')],
      [label('svc_work_done_label', 'Work Carried Out'), entry('svc_work_done', 'Activities performed', 9)],
      [label('svc_parts_label', 'Parts Replaced'), entry('svc_parts', 'Parts or consumables replaced', 9)],
      [label('svc_condition_label', 'Instrument Condition'), dataMasterField('svc_condition', 'dm_sample_condition', 0), label('svc_outcome_label', 'Result'), entry('svc_outcome', 'Satisfactory', 3)],
      [label('svc_reviewed_by_label', 'Reviewed By'), transitionField('svc_reviewed_by', 'Reviewer'), label('svc_reviewed_on_label', 'Reviewed On'), transitionField('svc_reviewed_on', 'Review date')],
      [label('svc_closed_by_label', 'Closed By'), transitionField('svc_closed_by', 'Closed by'), label('svc_closed_on_label', 'Closed On'), transitionField('svc_closed_on', 'Closing date')],
    ] },
  ],
};

export const templateDefinitions = Object.freeze([analyticalDatasheet, certificateOfAnalysis, instrumentServiceRecord]);
