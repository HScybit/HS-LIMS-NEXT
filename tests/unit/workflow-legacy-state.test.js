import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowStateInput } from '../../src/workflows/input.js';
import { buildWorkflowCloneRows } from '../../src/workflows/clone.js';

const state = { code: 'approved', name: 'Approved', stateType: 'final' };

test('hidden legacy request states retain exact text, explicit absence and omitted old-client fields', () => {
  assert.equal(Object.hasOwn(workflowStateInput(state), 'legacyTrState'), false);
  assert.equal(Object.hasOwn(workflowStateInput({ ...state, legacyTrState: undefined }), 'legacyTrState'), false);
  for (const value of [null, '', ' ', 'allocated', 'sent_for_approval', 'approved', 'Reviewed', '  custom state  ', '0', 'x'.repeat(150)]) {
    assert.equal(workflowStateInput({ ...state, legacyTrState: value }).legacyTrState, value);
  }
  for (const value of [false, true, 0, {}, [], '\0', '\ud800', 'x'.repeat(151)]) {
    assert.throws(() => workflowStateInput({ ...state, legacyTrState: value }), { code: 'invalid_workflow_input' });
  }
});

test('draft clone records preserve the hidden identifier independently of display names and state codes', () => {
  const states = ['approved', '', null].map((legacyTrState, index) => ({ id: `state-${index}`, code: `state_${index}`,
    name: 'Displayed state', legacyTrState, capabilityRoles: [] }));
  const definition = { workflow: { organizationId: 'tenant' }, states, transitions: [] };
  const cloned = buildWorkflowCloneRows(definition, 'new-version');
  assert.deepEqual(cloned.states.map((row) => row.legacyTrState), ['approved', '', null]);
  for (const [index, row] of cloned.states.entries()) {
    assert.notEqual(row.id, states[index].id); assert.equal(row.name, states[index].name); assert.equal(row.code, states[index].code);
  }
  assert.deepEqual(definition.states, states);
});
