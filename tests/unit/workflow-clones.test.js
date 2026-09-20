import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildWorkflowCloneRows } from '../../src/workflows/clone.js';

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function graph() {
  const org = randomUUID(); const version = randomUUID(); const role = randomUUID(); const template = randomUUID();
  const states = [0, 1].map((index) => ({ organizationId: org, workflowVersionId: version, id: randomUUID(), code: `state-${index}`, name: '',
    canvasX: index ? null : 0, canvasY: 100000, inputCount: 8, outputCount: 8, badgeStyle: null, color: null,
    showSampleEdit: false, enableJobCard: true, templateId: template, capabilityRoles: [{ roleId: role, capability: 'view' }] }));
  const transitions = [0, 1].map((index) => {
    const id = randomUUID(); const base = { organizationId: org, transitionId: id };
    return { organizationId: org, workflowVersionId: version, id, sourceStateId: states[index].id, targetStateId: states[1 - index].id,
      sourcePort: index ? null : 8, targetPort: 1, code: `edge-${index}`, name: 'Move', approvalMode: 'sequential', requireComment: false,
      checklistMasterId: randomUUID(), checklistMasterRevision: index ? null : 4,
      autoMoveMode: index ? null : 'all_trs_approved', autoExecute: Boolean(index),
      creatorRoleIds: [role], ccRoleIds: [role], approverStages: [{ stageNumber: 1, roleIds: [role] }, { stageNumber: 3, roleIds: [role] }],
      ccEmails: ['review@example.invalid'], conditions: [
        { ...base, id: randomUUID(), comparisonText: '', comparisonNumber: null, comparisonBoolean: null, comparisonDate: null },
        { ...base, id: randomUUID(), comparisonText: null, comparisonNumber: '0.000000000000000000000001', comparisonBoolean: null, comparisonDate: null },
        { ...base, id: randomUUID(), comparisonText: null, comparisonNumber: null, comparisonBoolean: false, comparisonDate: null },
        { ...base, id: randomUUID(), comparisonText: null, comparisonNumber: null, comparisonBoolean: null, comparisonDate: '2024-02-29' },
      ], checklist: [{ ...base, id: randomUUID(), prompt: 'Optional', isRequired: false, displayOrder: 0 }] };
  });
  return { workflow: { organizationId: org }, states, transitions };
}

test('workflow clone assembly preserves typed values and shared references while remapping a cyclic graph', () => {
  const source = freeze(graph()); const unchanged = structuredClone(source); const target = randomUUID();
  const rows = buildWorkflowCloneRows(source, target);
  assert.deepEqual(source, unchanged);
  assert.equal(rows.states[0].canvasX, 0); assert.equal(rows.states[1].canvasX, null); assert.equal(rows.states[0].canvasY, 100000);
  assert.equal(rows.states[0].templateId, source.states[0].templateId); assert.equal(rows.states[0].badgeStyle, null);
  assert.equal(rows.states[0].showSampleEdit, false); assert.equal(rows.states[0].enableJobCard, true);
  assert.equal(rows.transitions[0].sourceStateId, rows.states[0].id); assert.equal(rows.transitions[0].targetStateId, rows.states[1].id);
  assert.equal(rows.transitions[1].sourceStateId, rows.states[1].id); assert.equal(rows.transitions[1].targetStateId, rows.states[0].id);
  assert.equal(rows.transitions[0].sourcePort, 8); assert.equal(rows.transitions[1].sourcePort, null);
  for (const [index, edge] of rows.transitions.entries()) {
    assert.equal(edge.checklistMasterId, source.transitions[index].checklistMasterId);
    assert.equal(edge.checklistMasterRevision, source.transitions[index].checklistMasterRevision);
    assert.equal(edge.autoMoveMode, source.transitions[index].autoMoveMode); assert.equal(edge.autoExecute, source.transitions[index].autoExecute);
  }
  assert.deepEqual(rows.approverRoles.map((item) => item.stageNumber), [1, 3, 1, 3]);
  assert.equal(rows.conditions[0].comparisonText, ''); assert.equal(rows.conditions[1].comparisonNumber, '0.000000000000000000000001');
  assert.equal(rows.conditions[2].comparisonBoolean, false); assert.equal(rows.conditions[3].comparisonDate, '2024-02-29');
  assert.equal(rows.checklist[0].isRequired, false); assert.equal(rows.checklist[0].displayOrder, 0);
  assert.ok(rows.states.every((state) => state.workflowVersionId === target && !Object.hasOwn(state, 'capabilityRoles')));
  assert.ok(rows.transitions.every((edge) => edge.workflowVersionId === target && !Object.hasOwn(edge, 'conditions')));
  const generated = [...rows.states, ...rows.transitions, ...rows.conditions, ...rows.checklist].map((item) => item.id);
  const originals = new Set([...source.states, ...source.transitions, ...source.transitions.flatMap((edge) => [...edge.conditions, ...edge.checklist])].map((item) => item.id));
  assert.equal(new Set(generated).size, generated.length); assert.ok(generated.every((id) => !originals.has(id)));
  for (const records of Object.values(rows)) assert.ok(records.every((row) => row.organizationId === source.workflow.organizationId));
  for (const key of ['creatorRoles', 'approverRoles', 'ccRoles', 'emails', 'conditions', 'checklist']) {
    assert.ok(rows[key].every((row) => rows.transitions.some((edge) => edge.id === row.transitionId)));
  }
  assert.equal(rows.stateRoles[0].roleId, source.states[0].capabilityRoles[0].roleId);
  rows.conditions[0].comparisonText = 'Changed copy'; assert.equal(source.transitions[0].conditions[0].comparisonText, '');
});

test('empty workflow clone assembly produces empty relations and rejects missing endpoints', () => {
  const empty = buildWorkflowCloneRows({ workflow: { organizationId: randomUUID() }, states: [], transitions: [] }, randomUUID());
  assert.ok(Object.values(empty).every((rows) => rows.length === 0));
  const invalid = graph(); invalid.transitions[0].sourceStateId = randomUUID();
  assert.throws(() => buildWorkflowCloneRows(invalid, randomUUID()), /missing state/);
});
