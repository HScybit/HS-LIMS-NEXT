import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, revision, bool, decimal } from '../templates/input.js';

export const reportTypes = ['consolidated', 'product_wise', 'parameter_wise'];
export const defaultPrintSettings = Object.freeze({ pageSize: 'A4', scale: '1', xMargin: '1', isLandscape: false, printHeader: true, printFooter: true,
  printWithoutSignature: false, printWithoutImage: false, useCustomTopMargin: false, topMargin: '1', useCustomBottomMargin: false, bottomMargin: '1' });

export function printSettingsInput(input = {}) {
  fieldsOnly(input, Object.keys(defaultPrintSettings));
  const result = { ...defaultPrintSettings, ...input };
  if (!['A3', 'A4', 'A5', 'Letter', 'Legal'].includes(result.pageSize)) throw new HttpError(400, 'invalid_page_size', 'Select a supported page size.');
  for (const key of ['isLandscape', 'printHeader', 'printFooter', 'printWithoutSignature', 'printWithoutImage', 'useCustomTopMargin', 'useCustomBottomMargin']) result[key] = bool(result[key], key);
  for (const key of ['scale', 'xMargin', 'topMargin', 'bottomMargin']) {
    const value = decimal(result[key], key);
    const min = key === 'scale' ? 0.1 : 0; const max = key === 'scale' ? 1 : 500;
    if (Number(value) < min || Number(value) > max) throw new HttpError(400, 'invalid_print_setting', `${key} must be between ${min} and ${max}.`);
    result[key] = value;
  }
  return result;
}

export function reportGenerationInput(input) {
  fieldsOnly(input, ['requestId', 'revision', 'reportType', 'templateSelections', 'selectedSampleTestIds', 'printConfig', 'finalizeSample']);
  const requestId = uuid(input.requestId, 'Generation request').toLowerCase();
  const expectedRevision = revision(input.revision);
  if (!reportTypes.includes(input.reportType)) throw new HttpError(400, 'invalid_report_type', 'Select a report type.');
  if (!Array.isArray(input.selectedSampleTestIds) || !input.selectedSampleTestIds.length || input.selectedSampleTestIds.length > 1000) throw new HttpError(400, 'invalid_report_selection', 'Select between 1 and 1,000 tests.');
  const selectedSampleTestIds = input.selectedSampleTestIds.map((id) => uuid(id, 'Selected test').toLowerCase());
  if (new Set(selectedSampleTestIds).size !== selectedSampleTestIds.length) throw new HttpError(400, 'duplicate_report_test', 'Select each test only once.');
  if (!Array.isArray(input.templateSelections) || !input.templateSelections.length || input.templateSelections.length > 250) throw new HttpError(400, 'invalid_report_templates', 'Select report templates for the selected groups.');
  const templateSelections = input.templateSelections.map((selection) => {
    fieldsOnly(selection, ['key', 'templateId']);
    const key = selection.key === 'consolidated' ? selection.key : uuid(selection.key, 'Product group').toLowerCase();
    return { key, templateId: uuid(selection.templateId, 'Report template').toLowerCase() };
  });
  if (new Set(templateSelections.map((selection) => selection.key)).size !== templateSelections.length) throw new HttpError(400, 'duplicate_report_template', 'Select one template for each group.');
  return { requestId, revision: expectedRevision, reportType: input.reportType, selectedSampleTestIds, templateSelections,
    printConfig: printSettingsInput(input.printConfig), finalizeSample: bool(input.finalizeSample === undefined ? false : input.finalizeSample, 'Finalise sample') };
}

export function reportGroups(results, input) {
  const selected = new Set(input.selectedSampleTestIds);
  const rows = results.filter((result) => selected.has(result.sampleTestId));
  if (rows.length !== selected.size) throw new HttpError(422, 'invalid_report_test', 'A selected test is unavailable for this sample.');
  const groups = new Map();
  for (const row of rows) {
    const key = input.reportType === 'consolidated' ? 'consolidated' : input.reportType === 'product_wise' ? `product:${row.sampleProductId}` : `parameter:${row.sampleTestId}`;
    if (!groups.has(key)) groups.set(key, { key, templateKey: input.reportType === 'consolidated' ? 'consolidated' : row.sampleProductId,
      sampleProductId: input.reportType === 'consolidated' ? null : row.sampleProductId, sampleTestId: input.reportType === 'parameter_wise' ? row.sampleTestId : null, results: [] });
    groups.get(key).results.push(row);
  }
  const templates = new Map(input.templateSelections.map((selection) => [selection.key, selection.templateId]));
  for (const group of groups.values()) {
    group.templateId = templates.get(group.templateKey);
    if (!group.templateId) throw new HttpError(422, 'report_template_required', 'Select a template for every report group.');
  }
  if (input.templateSelections.some((selection) => ![...groups.values()].some((group) => group.templateKey === selection.key))) throw new HttpError(422, 'unused_report_template', 'A template selection does not belong to the selected report groups.');
  return [...groups.values()];
}
