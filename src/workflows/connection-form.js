export const workflowApprovalChoices = [
  { value: 'none', label: 'No approval required' }, { value: 'any', label: 'Any one can approve' },
  { value: 'all', label: 'Everyone has to approve' }, { value: 'sequential', label: 'Sequential stages' },
];
export const workflowAutoMoveChoices = ['yes', 'no', 'all_trs_allocated', 'all_trs_approved'].map((value) => ({ value, label: value }));

const sameSet = (left, right) => { const values = new Set(left); return values.size === new Set(right).size && right.every((value) => values.has(value)); };

export function workflowConnectionsAtPorts(transitions, ports) {
  return transitions.filter((transition) => transition.sourceStateId === ports.sourceStateId && transition.targetStateId === ports.targetStateId
    && (transition.sourcePort ?? 1) === ports.sourcePort && (transition.targetPort ?? 1) === ports.targetPort);
}

export function workflowConnectionIdentity(states, ports, transitions) {
  const source = states.find((state) => state.id === ports.sourceStateId); const target = states.find((state) => state.id === ports.targetStateId);
  if (!source || !target || source.id === target.id) throw new Error('Select different source and target nodes in this workflow.');
  const base = `${source.code || source.name || 'SOURCE'}-${target.code || target.name || 'TARGET'}`.trim().toUpperCase()
    .replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'TRANSITION';
  const used = new Set(transitions.map((transition) => transition.code.toUpperCase())); let code = base; let suffix = 2;
  while (used.has(code)) { code = `${base.slice(0, 60 - String(suffix).length)}-${suffix}`; suffix++; }
  // Native names allow 150 UTF-16 units; keep generated long names well formed.
  const name = `${source.name || 'Source'} → ${target.name || 'Target'}`.slice(0, 150).replace(/[\uD800-\uDBFF]$/, '');
  return { code, name };
}

export function workflowConnectionForm(connection) {
  return { approvalMode: connection?.approvalMode ?? 'none',
    approverRoleIds: [...new Set((connection?.approverStages ?? []).flatMap((stage) => stage.roleIds))],
    creatorRoleIds: [...connection?.creatorRoleIds ?? []], ccEmailText: (connection?.ccEmails ?? []).join(', '),
    autoMoveMode: connection ? connection.autoMoveMode ?? '' : 'no', checklistMasterId: connection?.checklistMasterId ?? null, refreshChecklist: false };
}

function emails(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new Error('Enter valid CC email addresses separated by commas.');
  const result = [...new Set(value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (result.length > 100 || result.some((email) => email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Enter at most 100 valid CC email addresses separated by commas.');
  }
  return result;
}

export function workflowConnectionSaveInput(connection, value, changed, { states, transitions, ports }) {
  const touched = new Set(changed); const original = workflowConnectionForm(connection); const result = {};
  if (!connection) {
    Object.assign(result, workflowConnectionIdentity(states, ports, transitions), ports);
    const source = states.find((state) => state.id === ports.sourceStateId); const target = states.find((state) => state.id === ports.targetStateId);
    for (const [port, count] of [[ports.sourcePort, source.outputCount ?? 1], [ports.targetPort, target.inputCount ?? 1]]) {
      if (!Number.isInteger(port) || port < 1 || port > count || port > 8) throw new Error('Select an available output and input port.');
    }
  }
  const rolesChanged = touched.has('approverRoleIds') && !sameSet(original.approverRoleIds, value.approverRoleIds);
  const modeChanged = touched.has('approvalMode') && original.approvalMode !== value.approvalMode;
  if (!connection || rolesChanged || modeChanged) {
    if (!workflowApprovalChoices.some((choice) => choice.value === value.approvalMode)) throw new Error('Select an approval condition.');
    if (value.approvalMode !== 'none' && (!value.approverRoleIds.length || value.approverRoleIds.length > 500)) throw new Error('Select 1 to 500 approver roles.');
    result.approvalMode = value.approvalMode;
    result.approverStages = value.approvalMode === 'none' ? [] : [{ stageNumber: 1, roleIds: [...value.approverRoleIds] }];
  }
  if (!connection || touched.has('creatorRoleIds') && !sameSet(original.creatorRoleIds, value.creatorRoleIds)) {
    if (value.creatorRoleIds.length > 500) throw new Error('Select at most 500 creator roles.');
    result.creatorRoleIds = [...value.creatorRoleIds];
  }
  if (!connection || touched.has('ccEmailText')) {
    const next = emails(value.ccEmailText);
    if (!connection || !sameSet(connection.ccEmails, next)) result.ccEmails = next;
  }
  if (!connection || touched.has('autoMoveMode') && value.autoMoveMode !== original.autoMoveMode) {
    if (!workflowAutoMoveChoices.some((choice) => choice.value === value.autoMoveMode)) throw new Error('Select an Auto Move mode.');
    result.autoMoveMode = value.autoMoveMode;
  }
  if (!connection || touched.has('checklistMasterId') && value.checklistMasterId !== original.checklistMasterId || value.refreshChecklist) {
    if (value.refreshChecklist && !value.checklistMasterId) throw new Error('Select a checklist before refreshing it.');
    result.checklistMasterId = value.checklistMasterId || null;
  }
  return result;
}
