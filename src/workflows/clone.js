import { randomUUID } from 'node:crypto';

// The caller loads and locks one canonical definition. Remap graph identities
// once, retaining typed values and references to the same templates and roles.
export function buildWorkflowCloneRows(definition, versionId) {
  const organizationId = definition.workflow.organizationId;
  const stateIds = new Map(definition.states.map((state) => [state.id, randomUUID()]));
  const rows = { states: [], stateRoles: [], transitions: [], creatorRoles: [], approverRoles: [], ccRoles: [], emails: [], conditions: [], checklist: [] };
  for (const { capabilityRoles, ...state } of definition.states) {
    const id = stateIds.get(state.id);
    rows.states.push({ ...state, id, organizationId, workflowVersionId: versionId });
    for (const role of capabilityRoles) rows.stateRoles.push({ ...role, organizationId, workflowStateId: id });
  }
  for (const { creatorRoleIds, approverStages, ccRoleIds, ccEmails, conditions, checklist, ...transition } of definition.transitions) {
    const sourceStateId = stateIds.get(transition.sourceStateId); const targetStateId = stateIds.get(transition.targetStateId);
    if (!sourceStateId || !targetStateId) throw new Error('Cannot clone a workflow connection with a missing state.');
    const id = randomUUID(); const base = { organizationId, transitionId: id };
    rows.transitions.push({ ...transition, id, organizationId, workflowVersionId: versionId, sourceStateId, targetStateId });
    for (const roleId of creatorRoleIds) rows.creatorRoles.push({ ...base, roleId });
    for (const stage of approverStages) for (const roleId of stage.roleIds) rows.approverRoles.push({ ...base, stageNumber: stage.stageNumber, roleId });
    for (const roleId of ccRoleIds) rows.ccRoles.push({ ...base, roleId });
    for (const email of ccEmails) rows.emails.push({ ...base, email });
    for (const condition of conditions) rows.conditions.push({ ...condition, ...base, id: randomUUID() });
    for (const item of checklist) rows.checklist.push({ ...item, ...base, id: randomUUID() });
  }
  return rows;
}
