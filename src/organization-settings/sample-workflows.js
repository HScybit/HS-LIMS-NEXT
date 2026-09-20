import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid } from '../templates/input.js';

export const sampleWorkflowTypes = [
  { key: 'base', label: 'Base Sample', column: 'sample_workflow_base_id' },
  { key: 'iqc', label: 'IQC Sample', column: 'sample_workflow_iqc_id' },
  { key: 'ilc', label: 'ILC Sample', column: 'sample_workflow_ilc_id' },
  { key: 'pt', label: 'PT Sample', column: 'sample_workflow_pt_id' },
  { key: 'amendment', label: 'Amendment Sample', column: 'sample_workflow_amendment_id' },
  { key: 'complaint', label: 'Complaint Sample', column: 'sample_workflow_complaint_id' },
];

export function sampleWorkflowSettingsInput(input) {
  if (!Object.hasOwn(input, 'sampleWorkflows')) return null;
  const value = input.sampleWorkflows;
  fieldsOnly(value, sampleWorkflowTypes.map(type => type.key));
  if (sampleWorkflowTypes.some(type => !Object.hasOwn(value, type.key))) {
    throw new HttpError(400, 'invalid_sample_workflows', 'Provide all six sample workflow selections together.');
  }
  return Object.fromEntries(sampleWorkflowTypes.map(({ key, label }) => [key, value[key] === null ? null : uuid(value[key], `${label} workflow`).toLowerCase()]));
}
