import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCaptureSize, MAX_CAPTURE_CELLS, MAX_CAPTURE_LAYOUT_NODES } from '../../src/templates/runtime-limits.js';

test('expanded size counts inherited repeat scope, empty groups and the inclusive cell boundary before allocation', () => {
  const fieldsById = Object.fromEntries(Array.from({ length: 100 }, (_, id) => [id, { repeatGroupId: 'repeat' }]));
  const model = { fieldsById, sectionsById: { section: {} }, rowsById: { row: { repeatGroupId: 'repeat', columnIds: ['one', 'two'] } } };
  const occurrences = [{ id: 'root' }, ...Array.from({ length: MAX_CAPTURE_CELLS / 100 }, (_, id) => ({ id, groupId: 'repeat' }))];
  assert.deepEqual(assertCaptureSize(model, occurrences), { cells: MAX_CAPTURE_CELLS, layoutNodes: 1501 });
  assert.throws(() => assertCaptureSize(model, [...occurrences, { id: 'extra', groupId: 'repeat' }]), { code: 'capture_size_limit' });
  assert.deepEqual(assertCaptureSize(model, [{ id: 'root' }]), { cells: 0, layoutNodes: 1 });
});

test('empty repeated layout is bounded even when it contains no field values', () => {
  const model = { fieldsById: {}, rowsById: { row: { repeatGroupId: 'repeat', columnIds: Array(199).fill('column') } } };
  const occurrences = Array.from({ length: MAX_CAPTURE_LAYOUT_NODES / 200 }, (_, id) => ({ id, groupId: 'repeat' }));
  assert.equal(assertCaptureSize(model, occurrences).layoutNodes, MAX_CAPTURE_LAYOUT_NODES);
  assert.throws(() => assertCaptureSize(model, [...occurrences, { id: 'extra', groupId: 'repeat' }]), { code: 'capture_size_limit' });
});
