import { randomUUID } from 'node:crypto';
import { database } from '../../src/db/pool.js';
import { insertBatch } from '../../src/templates/authoring.js';
import { createWorkflow, publishWorkflow } from '../../src/workflows/authoring.js';
import { stateFlags } from '../../src/workflows/input.js';
import * as w from '../../src/db/workflow-schema.js';

// Explicit synthetic graph, written outside benchmark timing through the app role.
export async function createWorkflowCloneFixture(client, identity, { edges = 1, roleId, templateId = null, details = true } = {}) {
  const workflow = await createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic workflow clone ${randomUUID()}`, appliesTo: 'sample' });
  const db = database(client); const organizationId = identity.organization_id;
  const states = Array.from({ length: edges + 1 }, (_, index) => ({
    organizationId, id: randomUUID(), workflowVersionId: workflow.versionId, code: `state-${index}`, name: `Synthetic state ${index}`,
    description: index ? 'Measured synthetic graph' : '', stateType: index === 0 ? 'initial' : index === edges ? 'final' : 'normal',
    displayOrder: index, canvasX: index * 20 % 100001, canvasY: index % 2 ? null : 0,
    inputCount: index === 0 ? 0 : 8, outputCount: index === edges ? 0 : 8, badgeStyle: index % 2 ? null : 'dark',
    color: index % 2 ? null : 'blue', templateId,
    ...Object.fromEntries(stateFlags.map((flag, position) => [flag, (index + position) % 2 === 0])),
  }));
  const transitions = Array.from({ length: edges }, (_, index) => ({
    organizationId, id: randomUUID(), workflowVersionId: workflow.versionId, code: `edge-${index}`, name: `Synthetic transition ${index}`,
    sourceStateId: states[index].id, targetStateId: states[index + 1].id, sourcePort: index % 2 ? null : 8, targetPort: index % 2 ? null : 8,
    approvalMode: details ? 'sequential' : 'none', autoExecute: false, requireComment: index % 2 === 0, displayOrder: index,
  }));
  await insertBatch(db, w.workflowStates, states);
  if (details) await insertBatch(db, w.workflowStateCapabilityRoles, states.map((state) => ({ organizationId, workflowStateId: state.id, capability: 'view', roleId })));
  await insertBatch(db, w.workflowTransitions, transitions);
  if (details) {
    for (const table of [w.workflowTransitionCreatorRoles, w.workflowTransitionCcRoles]) {
      await insertBatch(db, table, transitions.map((transition) => ({ organizationId, transitionId: transition.id, roleId })));
    }
    await insertBatch(db, w.workflowTransitionApproverRoles, transitions.flatMap((transition) => [1, 3].map((stageNumber) => ({ organizationId, transitionId: transition.id, roleId, stageNumber }))));
    await insertBatch(db, w.workflowTransitionCcEmails, transitions.map((transition) => ({ organizationId, transitionId: transition.id, email: 'synthetic@example.invalid' })));
    const comparisons = [{ comparisonText: '' }, { comparisonNumber: '0.000000000000000000000001' }, { comparisonBoolean: false }, { comparisonDate: '2024-02-29' }, {}];
    await insertBatch(db, w.workflowTransitionConditions, transitions.map((transition, index) => ({ organizationId, transitionId: transition.id, sourceField: 'synthetic.value',
      operator: index % comparisons.length === 4 ? 'is_null' : 'eq', displayOrder: 0, ...comparisons[index % comparisons.length] })));
    await insertBatch(db, w.workflowTransitionChecklistItems, transitions.map((transition, index) => ({ organizationId, transitionId: transition.id,
      prompt: index % 2 ? 'Optional synthetic check' : 'Required synthetic check', isRequired: index % 2 === 0, displayOrder: 0 })));
  }
  await publishWorkflow(client, identity, workflow.versionId, 1, 'Synthetic clone fixture');
  return workflow;
}

// Compare relationships by stable source code; generated graph/detail UUIDs differ.
export function workflowGraphValues(definition) {
  const stateCodes = new Map(definition.states.map((state) => [state.id, state.code]));
  return {
    states: definition.states.map(({ id: _id, organizationId: _org, workflowVersionId: _version, capabilityRoles, ...state }) => ({
      ...state, capabilityRoles: [...capabilityRoles].sort((a, b) => `${a.capability}:${a.roleId}`.localeCompare(`${b.capability}:${b.roleId}`)),
    })),
    transitions: definition.transitions.map(({ id: _id, organizationId: _org, workflowVersionId: _version, sourceStateId, targetStateId, conditions, checklist, ...transition }) => ({
      ...transition, sourceState: stateCodes.get(sourceStateId), targetState: stateCodes.get(targetStateId),
      creatorRoleIds: [...transition.creatorRoleIds].sort(), ccRoleIds: [...transition.ccRoleIds].sort(),
      approverStages: transition.approverStages.map((stage) => ({ ...stage, roleIds: [...stage.roleIds].sort() })),
      conditions: conditions.map(({ id: _id, organizationId: _org, transitionId: _transition, ...condition }) => condition),
      checklist: checklist.map(({ id: _id, organizationId: _org, transitionId: _transition, ...item }) => item),
    })),
  };
}
