import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticalRecords } from '../helpers/templates.js';
import { assembleDefinition } from '../../src/templates/model.js';
import { calculateCapture } from '../../src/templates/calculations.js';
import { templateView, captureView } from '../../src/templates/transport.js';

test('HTTP projection retains stable identities and equivalent calculations without mutating the relational model', () => {
  const records = analyticalRecords({ repeated: false });
  const model = assembleDefinition(records);
  const before = JSON.stringify(model);
  const projected = templateView(model);
  assert.equal(JSON.stringify(model), before);
  assert.deepEqual(Object.keys(projected.fieldsById), Object.keys(model.fieldsById));
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 }];
  const values = records.fields.filter((field) => field.widget !== 'formula_widget').map((field) => ({ fieldId: field.id, occurrenceId: 'root', state: 'present', valueType: 'numeric', numberValue: '0', textValue: null, booleanValue: null, dateValue: null }));
  const capture = captureView({ occurrences, values });
  assert.equal(capture.values[0].numberValue, '0');
  assert.equal(Object.hasOwn(capture.values[0], 'textValue'), false);
  const original = calculateCapture(model, occurrences, values);
  const transported = calculateCapture(projected, capture.occurrences, capture.values);
  assert.deepEqual(transported.calculated, original.calculated);
  assert.deepEqual(transported.validation, original.validation);
  for (const expression of Object.values(projected.expressions)) assert.equal(Object.hasOwn(expression, 'nodes'), false);
});
