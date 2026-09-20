import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecisionRuleFormula } from '../../src/masters/decision-rule-formula.js';

test('evaluates arithmetic and function calls against named variables', () => {
  const result = evaluateDecisionRuleFormula('moisture * 2 + ROUND(ash, 1)', { moisture: 12.5, ash: 3.14 });
  assert.deepEqual(result, { value: 28.1, error: null, errorType: null });
});

test('accepts a leading equals sign the same as without one', () => {
  const withEquals = evaluateDecisionRuleFormula('=moisture * 2', { moisture: 5 });
  const withoutEquals = evaluateDecisionRuleFormula('moisture * 2', { moisture: 5 });
  assert.deepEqual(withEquals, withoutEquals);
  assert.equal(withEquals.value, 10);
});

test('an empty formula is reported without evaluating', () => {
  for (const formula of ['', '   ', null, undefined, 42]) {
    const result = evaluateDecisionRuleFormula(formula, {});
    assert.equal(result.value, null); assert.match(result.error, /empty/);
  }
});

test('invalid syntax is reported without a specific HyperFormula error type', () => {
  const result = evaluateDecisionRuleFormula('moisture +* 2', { moisture: 1 });
  assert.equal(result.value, null); assert.match(result.error, /syntax/); assert.equal(result.errorType, null);
});

test('division by zero produces a DIV_BY_ZERO error', () => {
  const result = evaluateDecisionRuleFormula('moisture / zero', { moisture: 5, zero: 0 });
  assert.equal(result.value, null); assert.equal(result.errorType, 'DIV_BY_ZERO');
});

test('referencing an unprovided variable produces a NAME error', () => {
  const result = evaluateDecisionRuleFormula('moisture + missing', { moisture: 5 });
  assert.equal(result.value, null); assert.equal(result.errorType, 'NAME');
});

test('a variable value that is not a finite number is rejected before evaluation', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
    const result = evaluateDecisionRuleFormula('moisture + 1', { moisture: value });
    assert.equal(result.value, null); assert.equal(result.errorType, 'VALUE');
  }
});

test('a variable name that looks like a cell reference is rejected as an invalid name', () => {
  const result = evaluateDecisionRuleFormula('A1 + 1', { A1: 5 });
  assert.equal(result.value, null); assert.equal(result.errorType, 'NAME');
});

test('a formula producing a non-numeric result (text, boolean) is rejected', () => {
  const text = evaluateDecisionRuleFormula('"not a number"', {});
  assert.equal(text.value, null); assert.equal(text.errorType, 'VALUE');
  const boolean = evaluateDecisionRuleFormula('moisture > 1', { moisture: 5 });
  assert.equal(boolean.value, null); assert.equal(boolean.errorType, 'VALUE');
});

test('an out-of-range numeric result is reported as a NUM error', () => {
  const result = evaluateDecisionRuleFormula('moisture ^ 400', { moisture: 999 });
  assert.equal(result.value, null); assert.equal(result.errorType, 'NUM');
});

test('formulas with no variables at all still evaluate', () => {
  const result = evaluateDecisionRuleFormula('1 + 2 * 3', {});
  assert.deepEqual(result, { value: 7, error: null, errorType: null });
});

test('repeated calls do not leak state between evaluations', () => {
  evaluateDecisionRuleFormula('moisture + 1', { moisture: 5 });
  const result = evaluateDecisionRuleFormula('moisture + 1', {});
  assert.equal(result.value, null); assert.equal(result.errorType, 'NAME');
});
