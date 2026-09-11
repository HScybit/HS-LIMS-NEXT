import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, compileExpression, evaluateExpression, expressionText, formulaOrder } from '../../src/templates/expressions.js';

const references = { weight_a: 'field-a', weight_b: 'field-b' };
const resolve = (alias) => references[alias] ? { fieldId: references[alias], scope: 'current' } : null;
const values = { 'field-a': 4, 'field-b': 2 };
const evaluate = (formula, resolveValue = (id) => values[id]) => evaluateExpression(compileExpression(parseExpression(formula, resolve)), resolveValue);

// Characterized against the original hot-formula-parser, with synthetic variables.
test('preserves observed Meteor arithmetic, rounding, power and aggregate results', () => {
  for (const [formula, expected] of [
    ['ROUND(1.005,2)', 1], ['ROUND(-1.5,0)', -1], ['-2^2', -4], ['2^3^2', 64],
    ['SUM(weight_a,weight_b)', 6], ['AVERAGE(weight_a,weight_b)', 3],
    ['IF(weight_a>0,weight_a,weight_b)', 4], ['50%', 0.5], ['MIN(weight_a)', 4], ['SUM()', 0],
  ]) assert.equal(evaluate(formula), expected, formula);
  assert.throws(() => evaluate('IF(0,1/0,2)'), { code: 'expression_divide_by_zero' });
});

test('flat canonical expression nodes retain field identity when labels change', () => {
  const rows = parseExpression('weight_a + weight_b * 2', resolve);
  assert.equal(rows.filter((row) => row.kind === 'field').length, 2);
  assert.deepEqual(rows.filter((row) => row.kind === 'field').map((row) => row.fieldId), ['field-a', 'field-b']);
  assert.equal(expressionText(compileExpression(rows), (id) => ({ 'field-a': 'new_name', 'field-b': 'other_name' })[id]), '(new_name + (other_name * 2))');
  assert.equal(evaluateExpression(compileExpression(rows), (id) => values[id]), 8);
});

test('repeat aggregates accept ordered value arrays and distinguish empty/missing values from zero', () => {
  assert.equal(evaluate('SUM(weight_a)', () => [0, 1, 2]), 3);
  assert.equal(evaluate('AVERAGE(weight_a)', () => [0, 2]), 1);
  assert.equal(evaluate('SUM(weight_a)', () => []), 0);
  assert.equal(evaluate('weight_a + 1', () => 0), 1);
  assert.throws(() => evaluate('weight_a + 1', () => null), { code: 'expression_missing' });
  assert.throws(() => evaluate('weight_a + 1', () => ''), { code: 'expression_missing' });
  assert.throws(() => evaluate('weight_a + 1', () => [1, 2]), { code: 'expression_value' });
  assert.throws(() => evaluate('AVERAGE(weight_a)', () => []), { code: 'expression_divide_by_zero' });
});

test('rejects property access, stored code, unknown references, functions and excessive nesting', () => {
  for (const formula of ['window.fetch(1)', 'weight_a[0]', 'weight_a;alert(1)', 'constructor(1)', 'RUN(1)', 'weight_a + missing', '(', 'SUM(1,,2)']) {
    assert.throws(() => parseExpression(formula, resolve), undefined, formula);
  }
  assert.throws(() => parseExpression(`${'('.repeat(100)}1${')'.repeat(100)}`, resolve), { code: 'expression_limit' });
  assert.throws(() => parseExpression('1'.repeat(17000), resolve), { code: 'expression_syntax' });
  assert.throws(() => evaluate('1e308 * 10'), { code: 'expression_overflow' });
});

test('validates corrupted relational node trees instead of trusting stored shape', () => {
  const rows = parseExpression('weight_a + 1', resolve);
  assert.throws(() => compileExpression([...rows, rows[0]]), { code: 'expression_structure' });
  assert.throws(() => compileExpression(rows.map((row) => row.index === 1 ? { ...row, parentIndex: 9000 } : row)), { code: 'expression_structure' });
  assert.throws(() => compileExpression(rows.map((row) => row.index === 1 ? { ...row, operandOrder: 3 } : row)), { code: 'expression_structure' });
  assert.throws(() => compileExpression(rows.map((row) => row.index === 1 ? { ...row, operandOrder: 2 ** 32 - 1 } : row)), { code: 'expression_structure' });
  assert.throws(() => compileExpression([{ index: 0, kind: 'number', number: '' }]), { code: 'expression_overflow' });
  assert.throws(() => compileExpression([{ index: 0, parentIndex: null, operandOrder: 0, kind: 'call', functionName: 'constructor' }]), { code: 'expression_function' });
});

test('dependency order deduplicates references, resolves chains and rejects self and mutual cycles', () => {
  const ref = (fieldId) => ({ kind: 'field', fieldId });
  const order = formulaOrder(new Map([
    ['total', [ref('net'), ref('net')]], ['net', [ref('raw')]], ['raw', []],
  ]));
  assert.deepEqual(order, ['raw', 'net', 'total']);
  assert.throws(() => formulaOrder(new Map([['a', [ref('a')]]])), { code: 'expression_cycle' });
  assert.throws(() => formulaOrder(new Map([['a', [ref('b')]], ['b', [ref('a')]]])), { code: 'expression_cycle' });
});

test('preserves source text comparisons, function-specific coercion and fractional ROUND digits', () => {
  for (const [formula, expected] of [
    ['"PASS"="PASS"', true], ['"PASS"="pass"', false], ['"A"<>"B"', true], ['"10"<"2"', true], ['"2"=2', false], ['TRUE=1', false],
    ['SUM(TRUE,FALSE,1)', 1], ['SUM("abc",2)', 2], ['SUM("2",3)', 5], ['AVERAGE(TRUE,FALSE,2)', 2], ['MIN()', 0], ['MAX()', 0],
    ['MIN(TRUE,2)', 2], ['MAX("3",2)', 2], ['IF("abc",1,2)', 1], ['IF("",1,2)', 2], ['IF("0",1,2)', 1], ['ROUND(1.25,1.5)', 1.2649110640673518],
  ]) assert.equal(evaluate(formula), expected, formula);
  assert.throws(() => evaluate('TRUE+1'), { code: 'expression_value' });
  assert.throws(() => evaluate('ABS("12mg")'), { code: 'expression_value' });
  assert.throws(() => evaluate('IF(TRUE,2,1e308*10)'), { code: 'expression_overflow' });
  assert.equal(evaluate('MIN(weight_a)', () => []), 0);
  assert.equal(evaluate('SUM(weight_a)', () => [null, false, '2', 3]), 5);
  assert.throws(() => evaluate('SUM(weight_a)', () => [1, Infinity]), { code: 'expression_overflow' });
  assert.throws(() => evaluate('SUM(weight_a)', () => Array(100_001).fill(1)), { code: 'expression_limit' });
});
