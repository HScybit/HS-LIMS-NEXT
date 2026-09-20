import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowStatePatchInput, workflowTransitionPatchInput } from '../../src/workflows/patch-input.js';

const state = { code: 'node', name: 'Existing', canvasY: null, legacyTrState: 'sent_for_approval', generateTestRequests: true };
const transition = { code: 'edge', name: 'Connection', sourceStateId: randomUUID(), targetStateId: randomUUID(), approvalMode: 'sequential', autoMoveMode: 'all_trs_approved', autoExecute: false };

test('state patches include only explicit changes and preserve clears and zero without mutating inputs', () => {
  const input = { name: '  New name  ', canvasX: 0, outputCount: 0, templateId: null, accessRoleIds: [], showSampleEdit: false };
  const before = structuredClone(input); const existing = structuredClone(state);
  assert.deepEqual(workflowStatePatchInput(state, input), { ...input, name: 'New name' });
  assert.deepEqual(input, before); assert.deepEqual(state, existing);
  assert.deepEqual(workflowStatePatchInput(state, { legacyTrState: null }), { legacyTrState: null });
});

test('partial transition metadata does not introduce defaults or serialize hidden typed details', () => {
  const existing = { ...transition, conditions: [{ comparisonNumber: '0.000000000000000000000001' }], checklistMasterRevision: 7 };
  assert.deepEqual(workflowTransitionPatchInput(existing, { name: 'Renamed', ccEmails: [] }), { name: 'Renamed', ccEmails: [] });
  assert.deepEqual(existing.conditions, [{ comparisonNumber: '0.000000000000000000000001' }]);
  assert.deepEqual(workflowTransitionPatchInput(existing, { checklistMasterId: null }), { checklistMasterId: null });
});

test('approval patches validate the resulting mode and stages without flattening existing stages', () => {
  const stages = [{ stageNumber: 1, roleIds: [randomUUID()] }, { stageNumber: 3, roleIds: [randomUUID()] }];
  assert.deepEqual(workflowTransitionPatchInput(transition, { approvalMode: 'sequential' }, stages), { approvalMode: 'sequential' });
  assert.deepEqual(workflowTransitionPatchInput(transition, { approverStages: stages }), { approverStages: stages });
  assert.throws(() => workflowTransitionPatchInput(transition, { approvalMode: 'any' }, stages), { status: 400 });
  assert.throws(() => workflowTransitionPatchInput(transition, { approvalMode: 'none' }, stages), { status: 400 });
  assert.deepEqual(workflowTransitionPatchInput(transition, { approvalMode: 'none', approverStages: [] }, stages), { approvalMode: 'none', approverStages: [] });
});

test('automatic transition patches keep conditional history and follow explicit source mode changes', () => {
  assert.deepEqual(workflowTransitionPatchInput(transition, { autoExecute: false }), { autoExecute: false });
  assert.deepEqual(workflowTransitionPatchInput(transition, { autoExecute: true }), { autoExecute: true, autoMoveMode: 'yes' });
  assert.deepEqual(workflowTransitionPatchInput(transition, { autoMoveMode: 'all_trs_allocated', autoExecute: true }), { autoMoveMode: 'all_trs_allocated', autoExecute: false });
  assert.deepEqual(workflowTransitionPatchInput({ ...transition, autoMoveMode: null }, { name: 'Renamed' }), { name: 'Renamed' });
});

test('patches reject empty, undefined, unsupported, invalid text, invalid port and hidden detail writes', () => {
  for (const input of [null, [], {}, { name: undefined }, { id: randomUUID() }, { organizationId: randomUUID() }, { name: '\0' }, { name: '\uD800' }]) {
    assert.throws(() => workflowStatePatchInput(state, input), { status: 400 });
    assert.throws(() => workflowTransitionPatchInput(transition, input), { status: 400 });
  }
  for (const input of [{ canvasY: null }, { inputCount: 9 }, { outputCount: -1 }, { accessRoleIds: ['self'] }]) assert.throws(() => workflowStatePatchInput(state, input), { status: 400 });
  for (const input of [{ conditions: [] }, { checklist: [] }, { sourcePort: 0 }, { targetStateId: transition.sourceStateId }]) assert.throws(() => workflowTransitionPatchInput(transition, input), { status: 400 });
});
