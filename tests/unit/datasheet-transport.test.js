import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticalRecords } from '../helpers/templates.js';
import { assembleDefinition } from '../../src/templates/model.js';
import { calculateCapture, displayValue, valuePayload } from '../../src/templates/calculations.js';
import { indexOccurrences } from '../../src/templates/occurrences.js';
import { datasheetTemplateView, datasheetCaptureView } from '../../src/datasheets/transport.js';

test('runtime projection preserves layout, repeats and calculated display without changing the server definition', () => {
  const records = analyticalRecords();
  const model = assembleDefinition(records);
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 },
    ...['repeat-1', 'repeat-2'].map((id, position) => ({ id, groupId: records.groups[0].id, parentId: 'root', position }))];
  const values = occurrences.slice(1).map((occurrence, index) => ({ fieldId: records.fields[0].id, occurrenceId: occurrence.id,
    valueType: 'numeric', state: 'present', origin: 'entered', numberValue: String(index) }));
  const calculated = calculateCapture(model, occurrences, values);
  const before = JSON.stringify({ model, calculated });
  const projected = JSON.parse(JSON.stringify(datasheetTemplateView(model)));
  const capture = datasheetCaptureView({ revision: 1, occurrences, values: calculated.values });
  assert.equal(JSON.stringify({ model, calculated }), before);
  assert.deepEqual(projected.rootSectionIds, model.rootSectionIds);
  assert.deepEqual(projected.calculationOrder, model.calculationOrder);
  assert.equal(Object.hasOwn(projected, 'expressions'), false);
  for (const section of Object.values(model.sectionsById)) assert.deepEqual(projected.sectionsById[section.id].rowIds, section.rowIds);
  for (const row of Object.values(model.rowsById)) assert.deepEqual(projected.rowsById[row.id].columnIds, row.columnIds);
  for (const column of Object.values(model.columnsById)) {
    assert.deepEqual(projected.columnsById[column.id].childSectionIds, column.childSectionIds);
    assert.equal(projected.columnsById[column.id].fieldId, column.fieldId);
  }
  const runtime = indexOccurrences(projected, capture.occurrences);
  assert.deepEqual(runtime.forGroup('root', records.groups[0].id).map((row) => row.id), ['repeat-1', 'repeat-2']);
  for (const value of capture.values) assert.equal(displayValue(projected.fieldsById[value.fieldId], value), displayValue(model.fieldsById[value.fieldId], value));
  assert.deepEqual(calculateCapture(model, occurrences, values).calculated, calculated.calculated);
});

test('runtime transport retains zero, false, empty, absent, invalid and NA states and typed payloads through JSON', () => {
  const values = [
    { valueType: 'numeric', state: 'present', numberValue: '0', lexical: '0.00' },
    { valueType: 'boolean', state: 'present', booleanValue: false },
    { valueType: 'text', state: 'present', textValue: '' },
    { valueType: 'date', state: 'present', dateValue: '2026-09-12' },
    { valueType: 'option', state: 'present', optionId: 'choice' },
    { valueType: 'numeric', state: 'empty' }, { valueType: 'numeric', state: 'absent' },
    { valueType: 'numeric', state: 'not_applicable' },
    { valueType: 'numeric', state: 'invalid', errorCode: 'expression_divide_by_zero', errorMessage: 'Division by zero.' },
  ].map((value, index) => ({ fieldId: `field-${index}`, occurrenceId: 'root', revision: 2, origin: 'entered', savedBy: 'actor', savedAt: '2026-09-12T00:00:00Z', ...value }));
  const original = JSON.stringify(values);
  const projected = JSON.parse(JSON.stringify(datasheetCaptureView({ revision: 2, values }))).values;
  for (const [index, value] of projected.entries()) {
    const expected = values[index];
    assert.equal(value.fieldId, expected.fieldId); assert.equal(value.state, expected.state);
    assert.equal(valuePayload(value), valuePayload(expected)); assert.equal(value.errorMessage, expected.errorMessage);
    assert.equal(value.revision, 2); assert.equal(value.origin, 'entered');
  }
  assert.equal(displayValue({ valueType: 'numeric' }, projected[7]), 'NA');
  assert.equal(projected[0].lexical, '0.00');
  assert.equal(JSON.stringify(values), original);
  assert.deepEqual(datasheetCaptureView({ revision: 1, values: [] }), { revision: 1, values: [] });
});
