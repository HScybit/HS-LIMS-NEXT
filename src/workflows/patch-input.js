import { HttpError } from '../auth/errors.js';
import { fieldsOnly } from '../templates/input.js';
import { stateInputFields, workflowStateInput, workflowTransitionInput } from './input.js';

const transitionFields = ['code', 'name', 'sourceStateId', 'targetStateId', 'sourcePort', 'targetPort', 'approvalMode', 'autoExecute',
  'autoMoveMode', 'requireComment', 'displayOrder', 'creatorRoleIds', 'ccRoleIds', 'ccEmails', 'approverStages', 'checklistMasterId'];

function patchFields(input, allowed) {
  fieldsOnly(input, allowed);
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => input[key] === undefined)) throw new HttpError(400, 'invalid_workflow_patch', 'Supply the workflow fields to change.');
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && (!value.isWellFormed() || value.includes('\0'))) throw new HttpError(400, 'invalid_workflow_patch', 'Workflow fields contain invalid text.');
  }
  return keys;
}

export function workflowStatePatchInput(existing, input) {
  const keys = patchFields(input, stateInputFields);
  const value = workflowStateInput({ code: existing.code, name: existing.name, ...input });
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function workflowTransitionPatchInput(existing, input, currentStages = []) {
  const keys = patchFields(input, transitionFields);
  const approvalChanged = keys.includes('approvalMode') || keys.includes('approverStages');
  const value = workflowTransitionInput({ code: existing.code, name: existing.name,
    sourceStateId: existing.sourceStateId, targetStateId: existing.targetStateId,
    approvalMode: approvalChanged ? existing.approvalMode : 'none', approverStages: approvalChanged ? currentStages : [], ...input });
  const patch = Object.fromEntries(keys.map((key) => [key, value[key]]));
  if (keys.includes('autoMoveMode')) patch.autoExecute = patch.autoMoveMode === 'yes';
  else if (keys.includes('autoExecute') && patch.autoExecute !== existing.autoExecute) patch.autoMoveMode = patch.autoExecute ? 'yes' : 'no';
  return patch;
}
