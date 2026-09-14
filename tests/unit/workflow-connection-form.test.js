import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowConnectionForm, workflowConnectionIdentity, workflowConnectionSaveInput, workflowConnectionsAtPorts } from '../../src/workflows/connection-form.js';
import { workflowTransitionInput } from '../../src/workflows/input.js';
import { workflowTransitionPatchInput } from '../../src/workflows/patch-input.js';

const source = '00000000-0000-4000-8000-000000000001'; const target = '00000000-0000-4000-8000-000000000002';
const roleA = '00000000-0000-4000-8000-000000000003'; const roleB = '00000000-0000-4000-8000-000000000004';
const states = [{ id: source, name: 'Registered', code: 'REG', outputCount: 8 }, { id: target, name: 'Complete', code: 'DONE', inputCount: 2 }];
const ports = { sourceStateId: source, targetStateId: target, sourcePort: 8, targetPort: 2 };
const context = { states, transitions: [], ports };
const existing = { id: 'edge', code: 'KEEP', name: 'Historical name', ...ports, sourcePort: null, targetPort: null,
  approvalMode: 'sequential', approverStages: [{ stageNumber: 1, roleIds: [roleA] }, { stageNumber: 3, roleIds: [roleA, roleB] }],
  creatorRoleIds: [roleA], ccRoleIds: [roleB], ccEmails: ['old@example.invalid'], autoMoveMode: null, autoExecute: true,
  requireComment: true, checklistMasterId: source, checklistMasterRevision: 7, checklist: [{ prompt: 'Historical check' }],
  conditions: [{ comparisonNumber: '0.000000000000000000000001' }] };

test('new connections use the source defaults and unique identity with native port and name boundaries', () => {
  const form = workflowConnectionForm(null); assert.equal(form.approvalMode, 'none'); assert.equal(form.autoMoveMode, 'no');
  const input = workflowConnectionSaveInput(null, form, [], context); assert.equal(input.code, 'REG-DONE'); assert.equal(input.name, 'Registered → Complete');
  assert.equal(workflowTransitionInput(input).sourcePort, 8); assert.equal(workflowTransitionInput(input).approvalMode, 'none');
  assert.equal(workflowConnectionIdentity(states, ports, [{ code: 'reg-done' }, { code: 'REG-DONE-2' }]).code, 'REG-DONE-3');
  assert.equal(workflowConnectionIdentity(states.map((state) => ({ ...state, name: '中文', code: '中文' })), ports, []).code, 'TRANSITION');
  const name = workflowConnectionIdentity(states.map((state) => ({ ...state, name: 'a'.repeat(149) + '😀' })), ports, []).name;
  assert.equal(name.length, 149); assert.equal(name.isWellFormed(), true);
  for (const sourcePort of [0, 9, 1.5, null]) assert.throws(() => workflowConnectionSaveInput(null, form, [], { ...context, ports: { ...ports, sourcePort } }), /available/);
  assert.throws(() => workflowConnectionSaveInput(null, form, [], { ...context, ports: { ...ports, targetStateId: source } }), /different/);
  assert.throws(() => workflowConnectionSaveInput(null, form, [], { ...context, states: [] }), /different/);
});

test('unrelated changes and reordered role sets preserve exact hidden history and sequential stages', () => {
  const before = structuredClone(existing); const form = workflowConnectionForm(existing);
  assert.equal(form.autoMoveMode, ''); assert.deepEqual(form.approverRoleIds, [roleA, roleB]);
  assert.deepEqual(workflowConnectionSaveInput(existing, form, [], context), {});
  assert.deepEqual(workflowConnectionSaveInput(existing, { ...form, approverRoleIds: [roleB, roleA] }, ['approverRoleIds', 'approvalMode'], context), {});
  const patch = workflowConnectionSaveInput(existing, { ...form, ccEmailText: ' NEW@EXAMPLE.INVALID, new@example.invalid, , ' }, ['ccEmailText'], context);
  assert.deepEqual(patch, { ccEmails: ['new@example.invalid'] }); assert.deepEqual(workflowTransitionPatchInput(existing, patch), patch);
  assert.deepEqual(workflowConnectionSaveInput(existing, { ...form, ccEmailText: ' OLD@example.invalid,old@example.invalid' }, ['ccEmailText'], context), {});
  assert.deepEqual(existing, before);
});

test('deliberate approval changes follow the source single-stage mapping and none clears all stages', () => {
  const form = workflowConnectionForm(existing);
  const changed = workflowConnectionSaveInput(existing, { ...form, approverRoleIds: [roleB] }, ['approverRoleIds'], context);
  assert.deepEqual(changed, { approvalMode: 'sequential', approverStages: [{ stageNumber: 1, roleIds: [roleB] }] });
  assert.deepEqual(workflowTransitionPatchInput(existing, changed), changed);
  const none = workflowConnectionSaveInput(existing, { ...form, approvalMode: 'none' }, ['approvalMode'], context);
  assert.deepEqual(none, { approvalMode: 'none', approverStages: [] });
  assert.throws(() => workflowConnectionSaveInput(existing, { ...form, approverRoleIds: [] }, ['approverRoleIds'], context), /approver roles/);
  assert.throws(() => workflowConnectionSaveInput(existing, { ...form, approvalMode: 'unknown' }, ['approvalMode'], context), /condition/);
  assert.throws(() => workflowConnectionSaveInput(null, { ...workflowConnectionForm(null), approvalMode: 'any', approverRoleIds: Array(501).fill(roleA) }, [], context), /500/);
});

test('checklists refresh only when requested and changed fields cannot silently normalize legacy unknown modes', () => {
  const form = workflowConnectionForm(existing);
  assert.deepEqual(workflowConnectionSaveInput(existing, form, ['checklistMasterId', 'autoMoveMode'], context), {});
  assert.deepEqual(workflowConnectionSaveInput(existing, { ...form, checklistMasterId: null }, ['checklistMasterId'], context), { checklistMasterId: null });
  assert.deepEqual(workflowConnectionSaveInput(existing, { ...form, refreshChecklist: true }, ['refreshChecklist'], context), { checklistMasterId: source });
  assert.throws(() => workflowConnectionSaveInput(existing, { ...form, refreshChecklist: true, checklistMasterId: null }, [], context), /Select a checklist/);
  assert.deepEqual(workflowConnectionSaveInput(existing, { ...form, autoMoveMode: 'all_trs_approved' }, ['autoMoveMode'], context), { autoMoveMode: 'all_trs_approved' });
  assert.throws(() => workflowConnectionSaveInput(existing, { ...form, autoMoveMode: 'unknown' }, ['autoMoveMode'], context), /Auto Move/);
  for (const ccEmailText of ['invalid', 'a@b', 'a\0@b.invalid', '\ud800@b.invalid', Array.from({ length: 101 }, (_, i) => `a${i}@b.invalid`).join(',')]) {
    assert.throws(() => workflowConnectionSaveInput(existing, { ...form, ccEmailText }, ['ccEmailText'], context), /email/);
  }
});

test('port matches use exact state identities and default NULL ports without merging existing duplicates', () => {
  const edges = [{ id: 'first', sourceStateId: source, targetStateId: target, sourcePort: null, targetPort: null },
    { id: 'second', sourceStateId: source, targetStateId: target, sourcePort: 1, targetPort: 1 },
    { id: 'other', sourceStateId: target, targetStateId: source, sourcePort: 1, targetPort: 1 }];
  assert.deepEqual(workflowConnectionsAtPorts(edges, { ...ports, sourcePort: 1, targetPort: 1 }).map((edge) => edge.id), ['first', 'second']);
  assert.deepEqual(workflowConnectionsAtPorts(edges, ports), []);
});

test('unrelated edits preserve the native maximum of 100 stages with 500 roles per stage', () => {
  const connection = { ...existing, approverStages: Array.from({ length: 100 }, (_, index) => ({ stageNumber: index + 1,
    roleIds: Array.from({ length: 500 }, (_, role) => `synthetic-role-${index}-${role}`) })) };
  const value = workflowConnectionForm(connection); value.approverRoleIds.reverse(); value.ccEmailText = 'unchanged-stages@example.invalid';
  assert.deepEqual(workflowConnectionSaveInput(connection, value, ['approverRoleIds', 'ccEmailText'], context), { ccEmails: ['unchanged-stages@example.invalid'] });
  assert.equal(connection.approverStages.length, 100); assert.equal(connection.approverStages[0].roleIds[0], 'synthetic-role-0-0');
});
