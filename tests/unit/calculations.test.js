import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleDefinition } from '../../src/templates/model.js';
import { parseExpression } from '../../src/templates/expressions.js';
import { calculateCapture, valueKey } from '../../src/templates/calculations.js';
import { templateView } from '../../src/templates/transport.js';
import { analyticalRecords } from '../helpers/templates.js';
import { agreedResultValue } from '../../src/datasheets/job-results.js';

test('result formulas consume typed numbers and retain qualitative inputs when arithmetic cannot use them', () => {
  const records = analyticalRecords({ rowCount: 1, repeated: false });
  const field = records.fields[0]; field.widget = 'result_widget'; field.valueType = 'result';
  const model = assembleDefinition(records);
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 }];
  for (const definition of [model, templateView(model)]) {
    const value = { fieldId: field.id, occurrenceId: 'root', valueType: 'result', state: 'present', ...agreedResultValue(field, '4.20') };
    assert.equal(calculateCapture(definition, occurrences, [value]).calculated[0].numberValue, '8.4');
    const text = { ...value, numberValue: undefined, lexical: undefined, ...agreedResultValue(field, 'Not detected') };
    const failed = calculateCapture(definition, occurrences, [text]);
    assert.equal(failed.calculated[0].state, 'invalid');
    assert.equal(failed.values.find((item) => item.fieldId === field.id).textValue, 'Not detected');
  }
});

test('calculations and conditions use frozen option values, normalize numeric variables and retain false', () => {
  const fields = [
    { id: 'choice', widget: 'dropdown_widget', valueType: 'option' },
    { id: 'text', widget: 'input_widget', valueType: 'text' },
    { id: 'checked', widget: 'checkbox_widget', valueType: 'boolean' },
    { id: 'result', widget: 'formula_widget', valueType: 'numeric' },
  ].map((field) => ({ ...field, alias: field.id, columnId: `column-${field.id}`, required: false }));
  const expression = (fieldId, purpose, formula) => ({ id: `${fieldId}-${purpose}`, fieldId, purpose,
    ...parseExpression(formula, (fieldId) => ({ fieldId, scope: 'current' })) });
  const model = assembleDefinition({ sections: [{ id: 'section', position: 0 }], rows: [{ id: 'row', sectionId: 'section', position: 0 }],
    columns: fields.map((field, position) => ({ id: field.columnId, rowId: 'row', position })), fields, groups: [],
    options: [{ id: 'option-pass', fieldId: 'choice', position: 0, value: 'PASS', label: 'Pass label' }],
    expressions: [expression('result', 'calculate', 'IF(choice="PASS",AVERAGE(text,2),0)'),
      expression('text', 'required', 'checked=FALSE'), expression('result', 'visible', 'text=2')] });
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 }];
  const values = [
    { fieldId: 'choice', valueType: 'option', optionId: 'option-pass' },
    { fieldId: 'text', valueType: 'text', textValue: ' 2 ' },
    { fieldId: 'checked', valueType: 'boolean', booleanValue: false },
  ].map((value) => ({ ...value, occurrenceId: 'root', state: 'present' }));
  for (const definition of [model, templateView(model)]) {
    const result = calculateCapture(definition, occurrences, values);
    assert.equal(result.calculated[0].numberValue, '2');
    assert.equal(result.validation[valueKey('text', 'root')].required, true);
    assert.equal(result.validation[valueKey('result', 'root')].visible, true);
    const changed = calculateCapture(definition, occurrences, values.map((value) => value.fieldId === 'text' ? { ...value, textValue: 'PASS' } : value));
    assert.equal(changed.calculated[0].numberValue, '2'); // AVERAGE ignores nonnumeric text.
    assert.equal(changed.validation[valueKey('result', 'root')].visible, false);
    const missing = calculateCapture(definition, occurrences, values.filter((value) => value.fieldId !== 'choice'));
    assert.equal(missing.calculated[0].state, 'invalid');
    assert.equal(missing.calculated[0].errorCode, 'expression_missing');
  }
});

test('formulaOnMissingValue and formulaOnError configure a formula field\'s behavior without changing the default (still an error)', () => {
  const fields = [
    { id: 'input', widget: 'number_widget', valueType: 'numeric' },
    { id: 'missing_default', widget: 'formula_widget', valueType: 'numeric' },
    { id: 'missing_zero', widget: 'formula_widget', valueType: 'numeric', formulaOnMissingValue: 'zero' },
    { id: 'missing_blank', widget: 'formula_widget', valueType: 'numeric', formulaOnMissingValue: 'blank' },
    { id: 'error_default', widget: 'formula_widget', valueType: 'numeric' },
    { id: 'error_blank', widget: 'formula_widget', valueType: 'numeric', formulaOnError: 'blank' },
  ].map((field) => ({ ...field, alias: field.id, columnId: `column-${field.id}`, required: false }));
  const additive = (fieldId) => ({ id: `${fieldId}-calculate`, fieldId, purpose: 'calculate', ...parseExpression('input+5', () => ({ fieldId: 'input', scope: 'current' })) });
  const divide = (fieldId) => ({ id: `${fieldId}-calculate`, fieldId, purpose: 'calculate', ...parseExpression('10/input', () => ({ fieldId: 'input', scope: 'current' })) });
  const model = assembleDefinition({ sections: [{ id: 'section', position: 0 }], rows: [{ id: 'row', sectionId: 'section', position: 0 }],
    columns: fields.map((field, position) => ({ id: field.columnId, rowId: 'row', position })), fields, groups: [], options: [],
    expressions: [additive('missing_default'), additive('missing_zero'), additive('missing_blank'), divide('error_default'), divide('error_blank')] });
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 }];

  // input has no saved value at all — a missing scalar reference.
  const missing = calculateCapture(model, occurrences, []);
  const at = (result, id) => result.calculated.find((value) => value.fieldId === id);
  assert.equal(at(missing, 'missing_default').state, 'invalid');
  assert.equal(at(missing, 'missing_default').errorCode, 'expression_missing');
  assert.equal(at(missing, 'missing_zero').state, 'present'); assert.equal(at(missing, 'missing_zero').numberValue, '5');
  assert.equal(at(missing, 'missing_blank').state, 'absent');

  // input is present as zero — a genuine division-by-zero computation error, not a missing value.
  const zero = calculateCapture(model, occurrences, [{ fieldId: 'input', occurrenceId: 'root', valueType: 'numeric', state: 'present', numberValue: '0' }]);
  assert.equal(at(zero, 'error_default').state, 'invalid'); assert.equal(at(zero, 'error_default').errorCode, 'expression_divide_by_zero');
  assert.equal(at(zero, 'error_blank').state, 'absent');
});

test('a single present descendant resolves as a scalar while multiple repeats remain an aggregate', () => {
  const records = analyticalRecords();
  const input = records.fields[0];
  const resultId = records.fields.at(-1).id;
  const expression = records.expressions.at(-1);
  Object.assign(expression, parseExpression('IF(raw_0=0,2,3)', () => ({ fieldId: input.id, scope: 'descendants' })));
  const model = assembleDefinition(records);
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 },
    { id: 'first', groupId: records.groups[0].id, parentId: 'root', position: 0 },
    { id: 'second', groupId: records.groups[0].id, parentId: 'root', position: 1 }];
  const values = [{ fieldId: input.id, occurrenceId: 'first', valueType: 'numeric', state: 'present', numberValue: '0' },
    { fieldId: input.id, occurrenceId: 'second', valueType: 'numeric', state: 'empty' }];
  const first = calculateCapture(model, occurrences, values);
  assert.equal(first.calculated.find((value) => value.fieldId === resultId).numberValue, '2');
  // With two present descendants, raw_0 resolves to a two-value array used directly in a
  // comparison (not a bare SUM/MIN/MAX/AVERAGE argument) — genuinely ambiguous, and now
  // rejected explicitly instead of the old engine's undocumented quirk of comparing the
  // array reference itself (always unequal to a number, regardless of its contents).
  const both = calculateCapture(model, occurrences, values.map((value) => value.occurrenceId === 'second' ? { ...value, state: 'present', numberValue: '1' } : value));
  const ambiguous = both.calculated.find((value) => value.fieldId === resultId);
  assert.equal(ambiguous.state, 'invalid');
  assert.equal(ambiguous.errorCode, 'expression_value');
  Object.assign(expression, parseExpression('SUM(raw_0)', () => ({ fieldId: input.id, scope: 'descendants' })));
  const sum = calculateCapture(assembleDefinition(records), occurrences, values);
  assert.equal(sum.calculated.find((value) => value.fieldId === resultId).numberValue, '0');
});
