import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowStateInput, workflowTransitionInput, workflowCommand, approvalDecisionInput, roleIds } from '../../src/workflows/input.js';
import { conditionValue, matchesCondition, workflowConditionsMatch } from '../../src/workflows/conditions.js';

const input = () => ({ code: 'review', name: 'Review', sourceStateId: randomUUID(), targetStateId: randomUUID() });
test('workflow input retains the four exact Auto Move choices and distinguishes an omitted historical mode', () => {
  assert.equal(Object.hasOwn(workflowTransitionInput(input()), 'autoMoveMode'), false);
  for (const autoMoveMode of ['yes', 'no', 'all_trs_allocated', 'all_trs_approved']) {
    assert.equal(workflowTransitionInput({ ...input(), autoMoveMode }).autoMoveMode, autoMoveMode);
  }
  for (const autoMoveMode of [null, '', 'YES', 'true', true, 1, 'all_trs_completed']) {
    assert.throws(() => workflowTransitionInput({ ...input(), autoMoveMode }), { code: 'invalid_workflow_input' });
  }
});
test('workflow checklist selection distinguishes omission and detachment and accepts all 200 master prompts', () => {
  const id = randomUUID();
  assert.equal(Object.hasOwn(workflowTransitionInput(input()), 'checklistMasterId'), false);
  assert.equal(workflowTransitionInput({ ...input(), checklistMasterId: null }).checklistMasterId, null);
  assert.equal(workflowTransitionInput({ ...input(), checklistMasterId: id.toUpperCase() }).checklistMasterId, id);
  const checklist = Array.from({ length: 200 }, (_, index) => ({ prompt: `Check ${index}`, isRequired: false }));
  assert.equal(workflowTransitionInput({ ...input(), checklistMasterId: id, checklist }).checklist.length, 200);
  assert.equal(workflowTransitionInput({ ...input(), checklistMasterId: null, checklist }).checklist[199].isRequired, false);
  assert.throws(() => workflowTransitionInput({ ...input(), checklistMasterId: '' }), { code: 'invalid_id' });
  assert.throws(() => workflowTransitionInput({ ...input(), checklistMasterRevision: 1 }), { code: 'invalid_input' });
  assert.throws(() => workflowTransitionInput({ ...input(), checklist: [...checklist, { prompt: 'Too many' }] }), { code: 'invalid_workflow_input' });
});
test('workflow approval modes require distinct, bounded stages and preserve any/all/sequential definitions', () => {
  assert.equal(workflowTransitionInput(input()).approvalMode, 'none');
  const roleId = randomUUID();
  for (const mode of ['any', 'all', 'sequential']) {
    assert.throws(() => workflowTransitionInput({ ...input(), approvalMode: mode }), { code: 'invalid_workflow_input' });
    assert.equal(workflowTransitionInput({ ...input(), approvalMode: mode, approverStages: [{ stageNumber: 1, roleIds: [roleId] }] }).approvalMode, mode);
  }
  assert.throws(() => workflowTransitionInput({ ...input(), approverStages: [{ stageNumber: 1, roleIds: [roleId] }] }), { code: 'invalid_workflow_input' });
  assert.throws(() => workflowTransitionInput({ ...input(), approvalMode: 'all', approverStages: [{ stageNumber: 2, roleIds: [roleId] }] }), { code: 'invalid_workflow_input' });
  assert.throws(() => roleIds([roleId, roleId.toUpperCase()]), { code: 'invalid_workflow_input' });
  assert.throws(() => workflowTransitionInput({ ...input(), approvalMode: 'sequential', approverStages: [{ stageNumber: 1, roleIds: [roleId] }, { stageNumber: 1, roleIds: [roleId] }] }), { code: 'invalid_workflow_input' });
  const ordered = workflowTransitionInput({ ...input(), approvalMode: 'sequential', approverStages: [{ stageNumber: 4, roleIds: [roleId] }, { stageNumber: 1, roleIds: [roleId] }] });
  assert.deepEqual(ordered.approverStages.map((stage) => stage.stageNumber), [1, 4]);
});
test('workflow input retains false, zero-text and empty comparisons, normalizes CC recipients and rejects foreign properties', () => {
  const value = workflowTransitionInput({ ...input(), checklist: [{ prompt: 'Optional check', isRequired: false }], conditions: [{ sourceField: 'sample.totalAmount', operator: 'eq', comparisonValue: '0' }, { sourceField: 'description', operator: 'eq', comparisonValue: '' }], ccEmails: ['Lab@Example.invalid', 'lab@example.invalid'] });
  assert.equal(value.checklist[0].isRequired, false); assert.equal(value.conditions[0].comparisonText, '0'); assert.equal(value.conditions[1].comparisonText, '');
  assert.deepEqual(value.ccEmails, ['lab@example.invalid']);
  for (const sourceField of ['__proto__.status', 'sample.constructor.name', 'sample[status]', 'sample.status;SELECT']) {
    assert.throws(() => workflowTransitionInput({ ...input(), conditions: [{ sourceField, operator: 'eq', comparisonValue: 'x' }] }), { code: 'invalid_workflow_input' });
  }
  assert.throws(() => workflowStateInput({ code: 'new', name: 'New', showSampleEdit: 'false' }), { code: 'invalid_input' });
  assert.throws(() => workflowCommand({ revision: 1, transitionId: randomUUID(), requestedBy: randomUUID() }), { code: 'invalid_input' });
  assert.throws(() => approvalDecisionInput({ decision: 'approve', decidedAt: '2020-01-01' }), { code: 'invalid_input' });
  assert.equal(workflowStateInput({ code: 'new', name: 'New', displayOrder: 0 }).displayOrder, 0);
});
test('workflow comparisons preserve characterized PERN null/numeric/text semantics without inherited property access', () => {
  const source = { sample: { total_amount: '0', description: '', complete: false }, ...Object.create({ inherited: 'secret' }) };
  assert.equal(conditionValue(source, 'sample.totalAmount'), '0'); assert.equal(conditionValue(Object.create({ status: 'approved' }), 'status'), undefined);
  assert.equal(matchesCondition('', 'is_null', null), true); assert.equal(matchesCondition(false, 'is_null', null), false);
  assert.equal(matchesCondition(null, 'gte', '0'), true); assert.equal(matchesCondition('10', 'gt', '2'), true);
  assert.equal(matchesCondition('10 mg', 'gt', '2'), false); assert.equal(matchesCondition('Water Test', 'contains', 'water'), true);
  assert.equal(matchesCondition('A', 'in', 'B, A'), true); assert.equal(matchesCondition(false, 'eq', 'false'), true);
  assert.equal(workflowConditionsMatch(source, [{ sourceField: 'sample.totalAmount', operator: 'eq', comparisonText: '0' }, { sourceField: 'sample.complete', operator: 'eq', comparisonBoolean: false }]), true);
  assert.equal(workflowConditionsMatch(source, [{ sourceField: 'sample.description', operator: 'is_not_null' }]), false);
});
