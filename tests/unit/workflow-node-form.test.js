import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowNodeForm, workflowNodeSaveInput, createWorkflowNodeCode, workflowNodeFlags, workflowNodeRoles } from '../../src/workflows/node-form.js';
import { stateFlags, stateRoles, workflowStateInput } from '../../src/workflows/input.js';
import { workflowStatePatchInput } from '../../src/workflows/patch-input.js';

test('new workflow nodes use source defaults and codes while empty and colliding names are handled', () => {
  const empty = workflowNodeForm(null, []); assert.equal(empty.stateType, 'initial'); assert.equal(empty.inputCount, 0);
  assert.equal(empty.canvasX, 120); assert.equal(empty.outputCount, 1);
  const value = workflowNodeSaveInput(null, empty, [], []); assert.equal(value.code, 'PENDING');
  assert.equal(workflowNodeForm(null, [{}]).stateType, 'normal');
  assert.equal(createWorkflowNodeCode('  pending @ review  ', ['pending-review', 'PENDING-REVIEW-2']), 'PENDING-REVIEW-3');
  assert.equal(createWorkflowNodeCode('中文'), 'STATE'); assert.equal(createWorkflowNodeCode('A'.repeat(100)).length, 56);
  assert.throws(() => workflowNodeSaveInput(null, { ...empty, name: ' ' }, [], []), /name is required/);
  for (const inputCount of ['', -1, 9, 1.5, 'x']) assert.throws(() => workflowNodeSaveInput(null, { ...empty, inputCount }, [], []), /whole numbers/);
});

test('node patches preserve unknown layout, hidden history and capability families on unrelated edits', () => {
  const state = { code: 'FIXED', name: 'Original', stateType: 'cancelled', inputCount: null, outputCount: null, badgeStyle: null,
    legacyTrState: '  Legacy  ', description: 'Hidden', capabilityRoles: [{ capability: 'approve', roleId: 'hidden' }, { capability: 'view', roleId: 'inactive' }] };
  const value = workflowNodeForm(state, [state]); assert.equal(value.inputCount, 1); assert.equal(value.stateType, 'cancelled');
  assert.deepEqual(value.accessRoleIds, ['inactive']);
  assert.deepEqual(workflowNodeSaveInput(state, { ...value, name: ' Renamed ' }, new Set(['name']), [state]), { name: 'Renamed' });
  assert.deepEqual(workflowNodeSaveInput(state, value, new Set(), [state]), {});
  assert.deepEqual(workflowNodeSaveInput(state, value, new Set(['inputCount']), [state]), { inputCount: 1 });
  assert.deepEqual(workflowNodeSaveInput(state, { ...value, accessRoleIds: [] }, new Set(['accessRoleIds']), [state]), { accessRoleIds: [] });
});

test('returning a field to its original value or reordering a role set does not write a new revision', () => {
  const state = { name: 'Name', stateType: 'initial', inputCount: 0, outputCount: 8, capabilityRoles: [
    { capability: 'allocate', roleId: 'one' }, { capability: 'allocate', roleId: 'two' }] };
  const value = workflowNodeForm(state, [state]);
  assert.deepEqual(workflowNodeSaveInput(state, { ...value, name: ' Name ', allocateRoleIds: ['two', 'one'] }, ['name', 'allocateRoleIds'], [state]), {});
  assert.deepEqual(workflowNodeSaveInput(state, { ...value, inputCount: '8', outputCount: '0' }, ['inputCount', 'outputCount'], [state]), { inputCount: 8, outputCount: 0 });
});

test('node controls match the native authoring fields and submit valid create and partial input', () => {
  assert.deepEqual(workflowNodeFlags.map(([field]) => field).sort(), stateFlags.filter(field => field !== 'showSampleReissue').sort());
  assert.deepEqual(Object.fromEntries(workflowNodeRoles.map(([field, , capability]) => [field, capability])), stateRoles);
  const created = workflowNodeSaveInput(null, workflowNodeForm(null, []), [], []);
  const normalized = workflowStateInput(created); assert.equal(normalized.stateType, 'initial'); assert.equal(normalized.inputCount, 0);
  const state = { ...normalized, legacyTrState: null, inputCount: null };
  const patch = workflowNodeSaveInput(state, { ...workflowNodeForm(state, [state]), name: 'Changed' }, ['name'], [state]);
  assert.deepEqual(workflowStatePatchInput(state, patch), { name: 'Changed' });
});

test('hidden reissue metadata survives partial edits and new nodes retain the existing false default', () => {
  for (const showSampleReissue of [true, false]) {
    const state = { code: 'ORIGINAL', name: 'Original', stateType: 'initial', inputCount: 0, outputCount: 1, showSampleReissue, capabilityRoles: [] };
    const value = workflowNodeForm(state, [state]); assert.equal(Object.hasOwn(value, 'showSampleReissue'), false);
    const patch = workflowNodeSaveInput(state, { ...value, name: 'Changed' }, ['name'], [state]);
    assert.deepEqual(workflowStatePatchInput(state, patch), { name: 'Changed' });
    assert.equal(state.showSampleReissue, showSampleReissue);
    assert.deepEqual(workflowNodeSaveInput(state, value, ['showSampleReissue'], [state]), {});
  }
  const created = workflowNodeSaveInput(null, workflowNodeForm(null, []), [], []);
  assert.equal(Object.hasOwn(created, 'showSampleReissue'), false); assert.equal(workflowStateInput(created).showSampleReissue, false);
});
