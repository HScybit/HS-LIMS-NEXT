import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowStateInput, workflowTransitionInput, stateLayoutDefaults } from '../../src/workflows/input.js';

const state = (changes = {}) => ({ code: 'pending', name: 'Pending', ...changes });
const transition = (changes = {}) => ({ code: 'approve', name: 'Approve', sourceStateId: randomUUID(), targetStateId: randomUUID(), ...changes });

test('workflow layout retains zero and maximum coordinates and counts without filling omitted edit fields', () => {
  const omitted = workflowStateInput(state());
  for (const field of Object.keys(stateLayoutDefaults)) assert.equal(Object.hasOwn(omitted, field), false);
  const value = workflowStateInput(state({ canvasX: 0, canvasY: 100000, inputCount: 0, outputCount: 8, badgeStyle: 'dark' }));
  assert.equal(value.canvasX, 0); assert.equal(value.canvasY, 100000); assert.equal(value.inputCount, 0); assert.equal(value.outputCount, 8);
  assert.equal(value.badgeStyle, 'dark');
  assert.deepEqual(stateLayoutDefaults, { canvasX: 120, canvasY: 120, inputCount: 1, outputCount: 1, badgeStyle: 'light' });
  for (const field of ['canvasX', 'canvasY', 'inputCount', 'outputCount']) {
    for (const value of [null, '', '0', false, -1, 0.5, NaN, Infinity, field.startsWith('canvas') ? 100001 : 9]) {
      assert.throws(() => workflowStateInput(state({ [field]: value })), { status: 400 });
    }
  }
  for (const badgeStyle of [null, '', 'strong', 'neutral', 'Dark', false]) assert.throws(() => workflowStateInput(state({ badgeStyle })), { status: 400 });
});

test('workflow connections preserve omitted ports and accept only integral source port numbers', () => {
  const omitted = workflowTransitionInput(transition());
  assert.equal(Object.hasOwn(omitted, 'sourcePort'), false); assert.equal(Object.hasOwn(omitted, 'targetPort'), false);
  const value = workflowTransitionInput(transition({ sourcePort: 8, targetPort: 1 }));
  assert.equal(value.sourcePort, 8); assert.equal(value.targetPort, 1);
  for (const field of ['sourcePort', 'targetPort']) for (const value of [0, -1, 9, 1.5, null, '1', false, NaN, Infinity]) {
    assert.throws(() => workflowTransitionInput(transition({ [field]: value })), { status: 400 });
  }
});
