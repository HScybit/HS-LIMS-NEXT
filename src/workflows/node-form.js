export const workflowNodeFlags = [
  ['isPositiveTermination', 'Positive Termination'], ['showSampleRetest', 'Show Sample Retest'],
  ['enableTemplateValidation', 'Enable Template Validation'],
  ['enableCriticalParametersValidation', 'Enable Critical Params Validation'], ['showSampleEdit', 'Show Sample Edit'],
  ['showAddResult', 'Show Add Result'], ['generateTestRequests', 'Generate Test Request'],
  ['requireAllTestRequestsAllocated', 'Require All TRs Allocated'], ['requireAllTestRequestsApproved', 'Require All TRs Approved'],
  ['fetchEnvironmentData', 'Fetch Environment Data'], ['canWorkOnTestRequest', 'Can Work On TR'], ['enableJobCard', 'Enable Job Card'],
];
export const workflowNodeRoles = [
  ['allocateRoleIds', 'Who Can Allocate', 'allocate'], ['editRoleIds', 'Who Can Edit Item', 'edit'],
  ['printCoaRoleIds', 'Who Can Print COA', 'download_report'], ['addResultRoleIds', 'Who Can Add Result', 'execute'],
  ['accessRoleIds', 'Access Roles', 'view'],
];
export const workflowBadgeColors = ['gray', 'blue', 'orange', 'yellow', 'red', 'green'];

export function createWorkflowNodeCode(value, existingCodes = []) {
  const base = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'STATE';
  const used = new Set(existingCodes.filter(Boolean).map((code) => String(code).toUpperCase()));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base.slice(0, 60 - String(suffix).length)}-${suffix}`)) suffix += 1;
  return `${base.slice(0, 60 - String(suffix).length)}-${suffix}`;
}

export function workflowNodeForm(state, states) {
  const value = state ? { name: state.name, stateType: state.stateType, color: state.color ?? 'gray',
    badgeStyle: state.badgeStyle ?? 'light', inputCount: state.inputCount ?? 1, outputCount: state.outputCount ?? 1,
    templateId: state.templateId ?? null } : { name: 'Pending', stateType: states.length ? 'normal' : 'initial', color: 'gray',
    badgeStyle: 'light', inputCount: states.length ? 1 : 0, outputCount: 1, templateId: null, canvasX: 120, canvasY: 120 };
  for (const [field] of workflowNodeFlags) value[field] = state?.[field] ?? false;
  for (const [field, , capability] of workflowNodeRoles) {
    value[field] = (state?.capabilityRoles ?? []).filter((role) => role.capability === capability).map((role) => role.roleId);
  }
  return value;
}

export function workflowNodeSaveInput(state, value, changed, states) {
  const name = value.name.trim();
  if (!name) throw new Error('Node name is required.');
  if (name.length > 150) throw new Error('Node name must contain at most 150 characters.');
  for (const field of ['inputCount', 'outputCount']) {
    if (value[field] === '' || !Number.isInteger(Number(value[field])) || Number(value[field]) < 0 || Number(value[field]) > 8) {
      throw new Error('Inputs and outputs must be whole numbers from 0 to 8.');
    }
  }
  const normalized = { ...value, name, inputCount: Number(value.inputCount), outputCount: Number(value.outputCount) };
  if (!state) return { ...normalized, code: createWorkflowNodeCode(name, states.map((node) => node.code)) };
  const original = workflowNodeForm(state, states);
  const roleFields = new Set(workflowNodeRoles.map(([field]) => field));
  const result = {};
  for (const field of changed) {
    if (!Object.hasOwn(normalized, field)) continue;
    const previous = roleFields.has(field) ? original[field] : state[field];
    const next = normalized[field];
    const equal = roleFields.has(field) ? previous.length === next.length && previous.every((id) => next.includes(id)) : previous === next;
    if (!equal) result[field] = next;
  }
  return result;
}
