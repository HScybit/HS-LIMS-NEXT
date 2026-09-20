import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, compileExpression, evaluateExpression, expressionText, formulaOrder } from '../../src/templates/expressions.js';

const references = { weight_a: 'field-a', weight_b: 'field-b' };
const resolve = (alias) => references[alias] ? { fieldId: references[alias], scope: 'current' } : null;
const values = { 'field-a': 4, 'field-b': 2 };
const evaluate = (formula, resolveValue = (id) => values[id]) => evaluateExpression(compileExpression(parseExpression(formula, resolve)), resolveValue);

// HyperFormula now owns arithmetic, comparison and function semantics (replacing the hand-built
// evaluator). These are genuine Excel-compatible results rather than the old custom engine's rules:
// ROUND rounds halves away from zero (ROUND(-1.5,0) is now -2, not JS Math.round's -1), unary minus
// binds tighter than exponentiation (-2^2 is now 4, not -4), and any function name HyperFormula
// recognizes now works (the old 7-function allowlist is gone).
test('arithmetic, rounding, power and aggregate results now follow real HyperFormula semantics', () => {
  for (const [formula, expected] of [
    ['ROUND(1.005,2)', 1], ['ROUND(-1.5,0)', -2], ['-2^2', 4], ['2^3^2', 64],
    ['SUM(weight_a,weight_b)', 6], ['AVERAGE(weight_a,weight_b)', 3],
    ['IF(weight_a>0,weight_a,weight_b)', 4], ['50%', 0.5], ['MIN(weight_a)', 4], ['SQRT(weight_a)', 2],
  ]) assert.equal(evaluate(formula), expected, formula);
  assert.throws(() => evaluate('IF(1/0,1,2)'), { code: 'expression_divide_by_zero' });
  // Unlike the old evaluator, HyperFormula's IF is lazily evaluated: an error in the untaken
  // branch's own literal computation no longer surfaces (a resolved field reference used
  // anywhere in the formula is still always resolved eagerly, see the missing-value test below).
  assert.equal(evaluate('IF(1,2,1/0)'), 2);
  assert.equal(evaluate('IF(0,1/0,2)'), 2);
});

test('a stored expression keeps field identity separate from its display label', () => {
  const stored = parseExpression('weight_a + weight_b * 2', resolve);
  assert.equal(stored.references.length, 2);
  assert.deepEqual(stored.references.map((row) => row.fieldId).sort(), ['field-a', 'field-b']);
  const compiled = compileExpression(stored);
  assert.equal(expressionText(compiled, (id) => ({ 'field-a': 'new_name', 'field-b': 'other_name' })[id]), 'new_name+other_name*2');
  assert.equal(evaluateExpression(compiled, (id) => values[id]), 8);
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

test('rejects unresolvable references, malformed syntax and excessive nesting', () => {
  for (const formula of ['weight_a[0]', 'weight_a;alert(1)', 'weight_a + missing', '(']) {
    assert.throws(() => parseExpression(formula, resolve), undefined, formula);
  }
  assert.throws(() => parseExpression(`${'('.repeat(100)}1${')'.repeat(100)}`, resolve), { code: 'expression_limit' });
  assert.throws(() => parseExpression('1'.repeat(17000), resolve), { code: 'expression_syntax' });
  assert.throws(() => evaluate('1e308 * 10'), { code: 'expression_overflow' });
  // 'window'/'constructor'/'RUN' are no longer rejected as unknown identifiers at parse time —
  // HyperFormula recognizes any function name in its own catalog and errors on the rest itself.
  assert.throws(() => evaluate('constructor(1)'), { code: 'expression_reference' });
  assert.throws(() => evaluate('RUN(1)'), { code: 'expression_reference' });
});

test('compileExpression re-validates a stored expression instead of trusting it', () => {
  const stored = parseExpression('weight_a + 1', resolve);
  assert.throws(() => compileExpression({ formulaText: stored.formulaText, references: [] }), { code: 'expression_reference' });
  assert.throws(() => compileExpression({ formulaText: stored.formulaText, references: [{ alias: 'weight_a', scope: 'current' }] }), { code: 'expression_structure' });
  assert.throws(() => compileExpression({ formulaText: stored.formulaText, references: [...stored.references, { alias: 'bogus alias', fieldId: 'field-a', scope: 'current' }] }), { code: 'expression_structure' });
  assert.throws(() => compileExpression({ formulaText: 'weight_a +', references: stored.references }), { code: 'expression_syntax' });
});

test('dependency order deduplicates references, resolves chains and rejects self and mutual cycles', () => {
  const compiled = (fieldId) => compileExpression(parseExpression('x+1', (alias) => alias === 'x' ? { fieldId, scope: 'current' } : null));
  const order = formulaOrder(new Map([
    ['total', compiled('net')], ['net', compiled('raw')], ['raw', compileExpression(parseExpression('1', () => null))],
  ]));
  assert.deepEqual(order, ['raw', 'net', 'total']);
  assert.throws(() => formulaOrder(new Map([['a', compiled('a')]])), { code: 'expression_cycle' });
  assert.throws(() => formulaOrder(new Map([['a', compiled('b')], ['b', compiled('a')]])), { code: 'expression_cycle' });
});

// Text comparison in HyperFormula is case-insensitive (real Excel behavior); "2"=2 stays false
// since text and number remain distinct types. Scalar (non-range) arguments to SUM/MIN/MAX/AVERAGE
// now follow HyperFormula's own literal-argument coercion (booleans and numeric text coerce to
// numbers) rather than the old engine's bespoke per-function inclusion rules; IF requires an
// actual boolean/number condition rather than accepting any truthy string.
test('comparisons and function coercion follow real HyperFormula semantics', () => {
  for (const [formula, expected] of [
    ['"PASS"="PASS"', true], ['"PASS"="pass"', true], ['"A"<>"B"', true], ['"10"<"2"', true], ['"2"=2', false], ['TRUE=1', false],
    ['SUM(TRUE,FALSE,1)', 2], ['SUM("2",3)', 5], ['AVERAGE(TRUE,FALSE,2)', 1],
    ['MIN(TRUE,2)', 1], ['MAX("3",2)', 3], ['IF("",1,2)', 2], ['ROUND(1.25,1.5)', 1.2649110640673518],
  ]) assert.equal(evaluate(formula), expected, formula);
  assert.equal(evaluate('TRUE+1'), 2);
  assert.throws(() => evaluate('SUM("abc",2)'), { code: 'expression_value' });
  assert.throws(() => evaluate('IF("abc",1,2)'), { code: 'expression_value' });
  assert.throws(() => evaluate('MIN()'), { code: 'expression_arguments' });
  assert.throws(() => evaluate('ABS("12mg")'), { code: 'expression_value' });
  // The untaken branch's literal overflow is never evaluated (lazy IF, see above).
  assert.equal(evaluate('IF(TRUE,2,1e308*10)'), 2);
  assert.equal(evaluate('MIN(weight_a)', () => []), 0);
  assert.equal(evaluate('SUM(weight_a)', () => [null, false, '2', 3]), 5);
  assert.throws(() => evaluate('SUM(weight_a)', () => [1, Infinity]), { code: 'expression_overflow' });
  assert.throws(() => evaluate('SUM(weight_a)', () => Array(100_001).fill(1)), { code: 'expression_limit' });
});
