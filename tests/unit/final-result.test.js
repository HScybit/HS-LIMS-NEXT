import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyticalRecords } from '../helpers/templates.js';
import { assembleDefinition } from '../../src/templates/model.js';
import { calculateCapture } from '../../src/templates/calculations.js';
import { canonicalDecimal, resolveFinalResult, validateSubmissionValues } from '../../src/datasheets/final-result.js';

function fixture({ repeated = false, section = false } = {}) {
  const records = analyticalRecords({ repeated });
  records.sections[0].isFinalResult = section;
  records.columns.at(-1).isFinalResult = true;
  const model = assembleDefinition(records);
  const occurrences = [{ id: randomUUID(), groupId: null, parentId: null, position: 0 }];
  if (repeated) for (let position = 0; position < 2; position += 1) occurrences.push({ id: randomUUID(), groupId: records.groups[0].id, parentId: occurrences[0].id, position });
  const entered = records.fields.filter((field) => field.widget === 'number_widget').flatMap((field) => occurrences
    .filter((occurrence) => occurrence.groupId === field.repeatGroupId)
    .map((occurrence) => ({ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', valueType: 'numeric', origin: 'entered', numberValue: '0', revision: 2 })));
  const calculation = calculateCapture(model, occurrences, entered);
  const values = calculation.values.map((value) => ({ ...value, revision: 2 }));
  return { records, model, occurrences, values, calculation };
}

test('exact decimal comparison preserves zero and exponent values without floating-point truncation', () => {
  assert.equal(canonicalDecimal('0.000'), canonicalDecimal('-0'));
  assert.equal(canonicalDecimal('001.2300e2'), canonicalDecimal('123'));
  assert.notEqual(canonicalDecimal('9007199254740993'), canonicalDecimal('9007199254740992'));
  for (const value of ['', null, undefined, 'NA', '.', '1kg', 'Infinity']) assert.equal(canonicalDecimal(value), null);
});

test('a final column pins the actual zero-valued field occurrence and saved revision', () => {
  const data = fixture();
  assert.deepEqual(resolveFinalResult(data.model, data.occurrences, data.values), {
    source: 'column', fieldId: data.records.fields.at(-1).id, occurrenceId: data.occurrences[0].id,
    valueRevision: 2, selectionSemantics: 'source-agreement-v1', resultType: 'numeric', numberValue: '0',
  });
  assert.doesNotThrow(() => validateSubmissionValues(data.model, { values: data.values }, data.calculation));
});

test('explicit columns preserve false, NA and text without conflating absence or empty input', () => {
  const data = fixture(); const field = data.model.fieldsById[data.records.fields.at(-1).id];
  const value = data.values.find((value) => value.fieldId === field.id);
  const resolve = () => resolveFinalResult(data.model, data.occurrences, data.values);
  field.widget = 'checkbox_widget'; field.valueType = 'boolean';
  Object.assign(value, { valueType: 'boolean', numberValue: undefined, booleanValue: false });
  assert.equal(resolve().booleanValue, false);
  Object.assign(value, { state: 'not_applicable', booleanValue: undefined });
  assert.equal(resolve().textValue, 'NA');
  field.widget = 'input_widget'; field.valueType = 'text';
  Object.assign(value, { state: 'present', valueType: 'text', textValue: '<LOQ' });
  assert.equal(resolve().textValue, '<LOQ');
  for (const state of ['absent', 'empty']) {
    Object.assign(value, { state, textValue: undefined });
    assert.throws(resolve, { code: 'final_result_required' });
  }
  Object.assign(value, { state: 'present', textValue: '   ' });
  assert.throws(resolve, { code: 'final_result_required' });
});

test('a final section checks every eligible repeated value and keeps the selected stable occurrence', () => {
  const data = fixture({ repeated: true, section: true });
  const result = resolveFinalResult(data.model, [...data.occurrences].reverse(), data.values);
  assert.equal(result.source, 'section'); assert.equal(result.fieldId, data.records.fields.at(-1).id);
  const removed = data.values.find((value) => value.fieldId === data.records.fields[1].id && value.occurrenceId === data.occurrences[2].id);
  data.values = data.values.filter((value) => value !== removed);
  assert.throws(() => resolveFinalResult(data.model, data.occurrences, data.values), { code: 'final_result_required' });
});

test('the actual Meteor UI-to-storage path and PERN select the later explicit final section', () => {
  const data = fixture({ section: true });
  const second = { ...data.records.sections[0], id: randomUUID(), position: 1 };
  data.records.sections.push(second); data.records.rows.at(-1).sectionId = second.id;
  const model = assembleDefinition(data.records);
  const result = resolveFinalResult(model, data.occurrences, data.values);
  assert.equal(result.fieldId, data.records.fields.at(-1).id);
  assert.equal(result.source, 'section');
});

test('numeric-prefix text is rejected as ambiguous (Q3: follow PERN), while exact large decimals compare safely without a lossy Number', () => {
  const data = fixture();
  const field = data.records.fields.at(-1); field.widget = 'input_widget'; field.valueType = 'text';
  data.records.expressions = data.records.expressions.filter((expression) => expression.fieldId !== field.id);
  const textModel = assembleDefinition(data.records);
  const value = data.values.find((value) => value.fieldId === field.id); value.valueType = 'text'; delete value.numberValue;
  for (const textValue of ['5 mg/L', '1e3', '+2', ' padded ']) {
    value.textValue = textValue;
    assert.throws(() => resolveFinalResult(textModel, data.occurrences, data.values), { code: 'final_result_invalid_text' });
  }
  // Clean digits-only text, even beyond Number.MAX_SAFE_INTEGER, is a valid numeric result: it is
  // never routed through a JS Number, so no PERN-style precision loss applies here.
  value.textValue = '9007199254740993';
  assert.equal(resolveFinalResult(textModel, data.occurrences, data.values).numberValue, '9007199254740993');
  value.textValue = '2.50';
  assert.equal(resolveFinalResult(textModel, data.occurrences, data.values).numberValue, '2.50');
});

test('required and report errors stay explicit, optional unrelated errors do not blanket-block submission', () => {
  const data = fixture(); const optional = data.values.find((value) => value.fieldId === data.records.fields[1].id);
  Object.assign(optional, { state: 'invalid', numberValue: undefined, errorCode: 'expression_divide_by_zero', errorMessage: 'Division by zero.' });
  data.calculation.calculated[0] = { ...optional };
  assert.doesNotThrow(() => validateSubmissionValues(data.model, { values: data.values }, data.calculation));
  assert.equal(resolveFinalResult(data.model, data.occurrences, data.values).numberValue, '0');
  const key = `${optional.fieldId}:${optional.occurrenceId}`;
  data.calculation.validation[key].required = true;
  // Q2 (show errors to the user): the block is a real error carrying the engine's own message.
  assert.throws(() => validateSubmissionValues(data.model, { values: data.values }, data.calculation), { code: 'final_result_calculation_error', message: 'Division by zero.' });
  data.model.columnsById[data.records.columns[1].id].isFinalResult = true;
  assert.throws(() => resolveFinalResult(data.model, data.occurrences, data.values), { code: 'final_result_calculation_error', message: 'Division by zero.' });
});

test('missing required inputs and stale calculated history cannot be submitted', () => {
  const data = fixture(); const entered = data.values.find((value) => value.origin === 'entered');
  const values = data.values.filter((value) => value !== entered);
  assert.throws(() => validateSubmissionValues(data.model, { values }, data.calculation), { code: 'required_template_values_missing' });
  data.values.find((value) => value.origin === 'calculated').numberValue = '42';
  assert.throws(() => validateSubmissionValues(data.model, { values: data.values }, data.calculation), { code: 'datasheet_calculation_stale' });
});
