import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decisionRuleInput } from '../../src/masters/decision-rules.js';

const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0,
  productId: randomUUID(), testParameterId: randomUUID(), methodId: randomUUID(), ...changes });

test('decision rule input defaults optional fields and normalizes empty selections', () => {
  const result = decisionRuleInput(input());
  assert.equal(result.name, null); assert.equal(result.parentDecisionRuleId, null); assert.equal(result.isTestGroupParent, false);
  assert.equal(result.cutoffValue, 0); assert.deepEqual(result.sampleCategoryIds, []); assert.deepEqual(result.instrumentIds, []);
  assert.equal(result.hasFormula, false); assert.deepEqual(result.formulaVariables, []); assert.deepEqual(result.limits, []);
});

test('decision rule test group rules require both a name and UID, and only a parent may set them', () => {
  for (const changes of [{ isTestGroupParent: true }, { isTestGroupParent: true, testGroupName: 'A' }, { isTestGroupParent: true, testGroupUid: 'A' },
    { testGroupName: 'A' }, { testGroupUid: 'A' }]) {
    assert.throws(() => decisionRuleInput(input(changes)), { code: 'invalid_decision_rule_test_group' });
  }
  assert.throws(() => decisionRuleInput(input({ isTestGroupParent: true, testGroupName: 'A', testGroupUid: 'not valid' })), { code: 'invalid_decision_rule_test_group' });
  const parent = decisionRuleInput(input({ isTestGroupParent: true, testGroupName: 'Group A', testGroupUid: 'GROUP_A' }));
  assert.equal(parent.name, 'Group A'); assert.equal(parent.testGroupUid, 'GROUP_A');
  assert.throws(() => decisionRuleInput(input({ isTestGroupParent: true, testGroupName: 'A', testGroupUid: 'A', parentDecisionRuleId: randomUUID() })),
    { code: 'invalid_decision_rule_test_group' });
});

test('decision rule formula flags require their corresponding text and validate variable keys', () => {
  assert.throws(() => decisionRuleInput(input({ hasFormula: true })), { code: 'invalid_decision_rule_formula' });
  assert.throws(() => decisionRuleInput(input({ hasDerivedFormula: true })), { code: 'invalid_decision_rule_formula' });
  const value = decisionRuleInput(input({ hasFormula: true, formula: 'A+B', formulaVariables: [{ key: 'A', label: 'Value A' }] }));
  assert.equal(value.formula, 'A+B'); assert.deepEqual(value.formulaVariables, [{ key: 'A', label: 'Value A', displayOrder: 0 }]);
  assert.throws(() => decisionRuleInput(input({ formulaVariables: [{ key: 'A', label: 'One' }, { key: 'a', label: 'Two' }] })), { code: 'invalid_decision_rule_formula' });
  assert.throws(() => decisionRuleInput(input({ formulaVariables: [{ key: 'not valid', label: 'One' }] })), { code: 'invalid_decision_rule_formula' });
});

test('decision rule limits require at least one bound, reject inverted ranges and cap the row count', () => {
  assert.throws(() => decisionRuleInput(input({ limits: [{ outcome: 'Pass' }] })), { code: 'invalid_decision_rule_limits' });
  assert.throws(() => decisionRuleInput(input({ limits: [{ lowerLimit: 10, upperLimit: 0, outcome: 'Pass' }] })), { code: 'invalid_decision_rule_limits' });
  assert.throws(() => decisionRuleInput(input({ limits: Array.from({ length: 101 }, () => ({ lowerLimit: 0, outcome: 'Pass' })) })), { code: 'invalid_decision_rule_limits' });
  const value = decisionRuleInput(input({ limits: [{ lowerLimit: '0', upperLimit: '10', outcome: 'Pass', narration: 'ok' }] }));
  assert.deepEqual(value.limits, [{ lowerLimit: 0, upperLimit: 10, lowerInclusive: true, upperInclusive: true, outcome: 'Pass', narration: 'ok', displayOrder: 0 }]);
});

test('decision rule reference lists reject duplicates, oversized selections and malformed identifiers', () => {
  const ids = Array.from({ length: 500 }, () => randomUUID());
  assert.deepEqual(decisionRuleInput(input({ sampleCategoryIds: ids })).sampleCategoryIds, ids);
  for (const sampleCategoryIds of [[...ids, randomUUID()], [ids[0], ids[0].toUpperCase()]]) {
    assert.throws(() => decisionRuleInput(input({ sampleCategoryIds })), { code: 'invalid_decision_rule_references' });
  }
  assert.throws(() => decisionRuleInput(input({ instrumentIds: ['missing'] })), { code: 'invalid_id' });
});
