import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, revision, text, integer, bool } from '../templates/input.js';

export const stateFlags = ['showSampleEdit', 'showSampleRetest', 'showSampleReissue', 'enableTemplateValidation', 'enableCriticalParametersValidation',
  'showAddResult', 'generateTestRequests', 'requireAllTestRequestsAllocated', 'requireAllTestRequestsApproved', 'fetchEnvironmentData', 'canWorkOnTestRequest', 'isPositiveTermination', 'enableJobCard'];
export const stateRoles = { accessRoleIds: 'view', editRoleIds: 'edit', allocateRoleIds: 'allocate', addResultRoleIds: 'execute', printCoaRoleIds: 'download_report' };
export const conditionOperators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_null', 'is_not_null'];
export const stateLayoutDefaults = Object.freeze({ canvasX: 120, canvasY: 120, inputCount: 1, outputCount: 1, badgeStyle: 'light' });
export const stateInputFields = Object.freeze(['code', 'name', 'description', 'stateType', 'color', 'templateId', 'displayOrder', 'legacyTrState', ...Object.keys(stateLayoutDefaults), ...stateFlags, ...Object.keys(stateRoles)]);

function choice(value, choices, label) {
  if (!choices.includes(value)) throw new HttpError(400, 'invalid_workflow_input', `Select a valid ${label}.`);
  return value;
}
export function boundedList(value = [], label, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) throw new HttpError(400, 'invalid_workflow_input', `${label} must contain at most ${maximum} entries.`);
  return value;
}
export function roleIds(value, label = 'Roles') {
  const result = boundedList(value, label, 500).map((id) => uuid(id, label).toLowerCase());
  if (new Set(result).size !== result.length) throw new HttpError(400, 'invalid_workflow_input', `${label} must be distinct.`);
  return result;
}
export function workflowStateInput(input) {
  fieldsOnly(input, stateInputFields);
  const result = { code: text(input.code, 'Code', 64), name: text(input.name, 'Name', 150), description: text(input.description, 'Description', 10000, { optional: true }),
    stateType: choice(input.stateType ?? 'normal', ['initial', 'normal', 'final', 'cancelled'], 'state type'),
    color: input.color == null ? null : text(input.color, 'Color', 20, { optional: true }), templateId: input.templateId == null ? null : uuid(input.templateId, 'Template'),
    ...(input.displayOrder === undefined ? {} : { displayOrder: integer(input.displayOrder, 'Position', 0, 100000) }) };
  for (const field of stateFlags) result[field] = bool(input[field] ?? false, field);
  for (const field of Object.keys(stateRoles)) result[field] = roleIds(input[field], field);
  // The source keeps this hidden identifier when a node's display name changes.
  if (input.legacyTrState !== undefined) {
    const value = input.legacyTrState;
    if (value !== null && (typeof value !== 'string' || value.length > 150 || !value.isWellFormed() || value.includes('\0'))) {
      throw new HttpError(400, 'invalid_workflow_input', 'The legacy test request state must be valid text of at most 150 characters.');
    }
    result.legacyTrState = value;
  }
  // Omitted layout fields must survive edits from clients that predate the canvas.
  for (const [field, maximum] of [['canvasX', 100000], ['canvasY', 100000], ['inputCount', 8], ['outputCount', 8]]) {
    if (input[field] !== undefined) result[field] = integer(input[field], field, 0, maximum);
  }
  if (input.badgeStyle !== undefined) result.badgeStyle = choice(input.badgeStyle, ['light', 'dark'], 'badge style');
  return result;
}
export function workflowTransitionInput(input) {
  fieldsOnly(input, ['code', 'name', 'sourceStateId', 'targetStateId', 'sourcePort', 'targetPort', 'approvalMode', 'autoExecute', 'autoMoveMode', 'requireComment', 'displayOrder', 'creatorRoleIds', 'ccRoleIds', 'ccEmails', 'approverStages', 'checklistMasterId', 'checklist', 'conditions']);
  const sourceStateId = uuid(input.sourceStateId, 'Source state').toLowerCase(); const targetStateId = uuid(input.targetStateId, 'Target state').toLowerCase();
  if (sourceStateId === targetStateId) throw new HttpError(400, 'invalid_workflow_input', 'Source and target states must differ.');
  const approvalMode = choice(input.approvalMode ?? 'none', ['none', 'any', 'all', 'sequential'], 'approval mode');
  const approverStages = boundedList(input.approverStages, 'Approval stages').map((stage) => {
    fieldsOnly(stage, ['stageNumber', 'roleIds']);
    const roles = roleIds(stage.roleIds);
    if (!roles.length) throw new HttpError(400, 'invalid_workflow_input', 'Every approval stage requires at least one role.');
    return { stageNumber: integer(stage.stageNumber, 'Stage number', 1, 100), roleIds: roles };
  }).sort((a, b) => a.stageNumber - b.stageNumber);
  if (new Set(approverStages.map((stage) => stage.stageNumber)).size !== approverStages.length
    || (approvalMode === 'none') === Boolean(approverStages.length)
    || (approvalMode !== 'sequential' && approverStages.some((stage) => stage.stageNumber !== 1))) {
    throw new HttpError(400, 'invalid_workflow_input', 'Approval mode and stages must agree. Only sequential approvals may define multiple stages.');
  }
  const ccEmails = [...new Set(boundedList(input.ccEmails, 'CC emails').map((email) => {
    const result = text(email, 'CC email', 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'invalid_email', 'Enter a valid CC email address.');
    return result;
  }))];
  const checklist = boundedList(input.checklist, 'Checklist', 200).map((item, displayOrder) => {
    fieldsOnly(item, ['id', 'prompt', 'isRequired']);
    return { ...(item.id ? { id: uuid(item.id, 'Checklist item').toLowerCase() } : {}), prompt: text(item.prompt, 'Checklist prompt', 500), isRequired: bool(item.isRequired ?? true, 'Required'), displayOrder };
  });
  const conditions = boundedList(input.conditions, 'Conditions').map((condition, displayOrder) => {
    fieldsOnly(condition, ['id', 'sourceField', 'operator', 'comparisonValue']);
    const sourceField = text(condition.sourceField, 'Condition field', 150);
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(sourceField) || sourceField.split('.').some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new HttpError(400, 'invalid_workflow_input', 'Conditions must reference an ordinary record field.');
    }
    return { ...(condition.id ? { id: uuid(condition.id, 'Condition').toLowerCase() } : {}), sourceField, operator: choice(condition.operator, conditionOperators, 'condition operator'),
      comparisonText: condition.comparisonValue == null ? null : text(condition.comparisonValue, 'Comparison value', 5000, { optional: true }), displayOrder };
  });
  for (const [label, entries] of [['Checklist items', checklist], ['Conditions', conditions]]) {
    const ids = entries.flatMap((entry) => entry.id ? [entry.id] : []);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_workflow_input', `${label} must have distinct identities.`);
  }
  return { code: text(input.code, 'Code', 64), name: text(input.name, 'Name', 150), sourceStateId, targetStateId, approvalMode,
    ...(input.checklistMasterId === undefined ? {} : { checklistMasterId: input.checklistMasterId === null ? null : uuid(input.checklistMasterId, 'Checklist master').toLowerCase() }),
    ...(input.sourcePort === undefined ? {} : { sourcePort: integer(input.sourcePort, 'Source port', 1, 8) }),
    ...(input.targetPort === undefined ? {} : { targetPort: integer(input.targetPort, 'Target port', 1, 8) }),
    ...(input.autoMoveMode === undefined ? {} : { autoMoveMode: choice(input.autoMoveMode, ['yes', 'no', 'all_trs_allocated', 'all_trs_approved'], 'auto move mode') }),
    autoExecute: bool(input.autoExecute ?? false, 'Automatic transition'), requireComment: bool(input.requireComment ?? false, 'Required comment'),
    ...(input.displayOrder === undefined ? {} : { displayOrder: integer(input.displayOrder, 'Position', 0, 100000) }),
    creatorRoleIds: roleIds(input.creatorRoleIds), ccRoleIds: roleIds(input.ccRoleIds), ccEmails, approverStages, checklist, conditions };
}
export function workflowCommand(input) {
  fieldsOnly(input, ['revision', 'transitionId', 'comment', 'checklistItemIds']);
  return { revision: revision(input.revision), transitionId: uuid(input.transitionId, 'Transition').toLowerCase(),
    comment: text(input.comment, 'Comments', 5000, { optional: true }).trim() || null, checklistItemIds: roleIds(input.checklistItemIds, 'Checklist items') };
}
export function approvalDecisionInput(input) {
  fieldsOnly(input, ['decision', 'comment', 'checklistItemIds']);
  return { decision: choice(input.decision, ['approve', 'reject'], 'decision'), comment: text(input.comment, 'Comments', 5000), checklistItemIds: roleIds(input.checklistItemIds, 'Checklist items') };
}
