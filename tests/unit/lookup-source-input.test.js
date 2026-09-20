import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lookupSourceInput, lookupSourceLineLimit } from '../../src/custom-fields/lookup-source-input.js';
import { customFieldInput } from '../../src/masters/custom-field-input.js';

const input = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original_Master_A', name: '', lines: [], ...changes });

test('lookup observations preserve external identity, label types, order and exact text', () => {
  const value = input({ name: '  Observed name\n', lines: [{ id: '__proto__', label: '  Label\n' }, { id: 'A', label: 0 },
    { id: 'a', label: false }, { id: 'flat-line:1', label: '' }, { id: 'negative', label: -0 }, { id: 'number', label: Number.MAX_VALUE }] });
  const result = lookupSourceInput({ ...value, id: value.id.toUpperCase(), requestId: value.requestId.toUpperCase() });
  assert.deepEqual(result, { ...value, lines: value.lines.map(line => line.id === 'negative' ? { ...line, label: 0 } : line) });
  assert.deepEqual(lookupSourceInput(input()).lines, []);
});

test('lookup observations reject duplicate identities and malformed or unsupported source values', () => {
  for (const sourceId of ['', ' ', null, 1, {}, 'a\0b', '\ud800', 'x'.repeat(201)]) assert.throws(() => lookupSourceInput(input({ sourceId })), { status: 400 });
  for (const name of [null, false, {}, '\ud800', 'a\0b', 'x'.repeat(16001)]) assert.throws(() => lookupSourceInput(input({ name })), { status: 400 });
  for (const lines of [null, {}, '', [null], [undefined], new Array(2), [{ id: '', label: 'A' }], [{ id: 'a', label: {} }],
    [{ id: 'a', label: [] }], [{ id: 'a', label: Infinity }], [{ id: 'a', label: NaN }], [{ id: 'a', label: null }],
    [{ id: 'a', label: '\ud800' }], [{ id: 'a', label: 'a\0b' }], [{ id: 'a', label: 'x'.repeat(16001) }],
    [{ id: 'a', label: 'A', parentId: 'ignored' }], [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }]]) {
    assert.throws(() => lookupSourceInput(input({ lines })), { status: 400 });
  }
  for (const changes of [{ id: 'source-not-a-native-uuid' }, { revision: -1 }, { revision: 0.5 }, { revision: 2147483647 },
    { sourceSystem: 'pern' }, { sourceDocument: {} }, { requestId: null }]) assert.throws(() => lookupSourceInput(input(changes)), { status: 400 });
});

test('lookup observation count and byte limits reject oversized data without truncating it', () => {
  const lines = Array.from({ length: lookupSourceLineLimit }, (_, index) => ({ id: String(index), label: 'Synthetic' }));
  assert.equal(lookupSourceInput(input({ lines })).lines.length, lookupSourceLineLimit);
  assert.throws(() => lookupSourceInput(input({ lines: [...lines, { id: 'overflow', label: '' }] })), { status: 400 });
  assert.throws(() => lookupSourceInput(input({ lines: lines.slice(0, 600).map(line => ({ ...line, label: 'x'.repeat(16000) })) })), { status: 413 });
  assert.throws(() => lookupSourceInput(input({ lines: lines.slice(0, 300).map(line => ({ ...line, label: '😀'.repeat(8000) })) })), { status: 413 });
});

test('custom fields retain hidden lookup bindings independently of the displayed type', () => {
  const id = randomUUID();
  const field = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'lookup', label: 'Lookup', associatedWith: 'users' };
  for (const fieldType of ['lookup', 'text', 'select']) {
    assert.equal(customFieldInput({ ...field, fieldType, lookupSourceId: id.toUpperCase() }).lookupSourceId, id);
  }
  for (const lookupSourceId of [undefined, '', null]) assert.equal(customFieldInput({ ...field, lookupSourceId }).lookupSourceId, null);
  for (const lookupSourceId of [false, 0, {}, 'original-source-text']) assert.throws(() => customFieldInput({ ...field, lookupSourceId }), { status: 400 });
});
