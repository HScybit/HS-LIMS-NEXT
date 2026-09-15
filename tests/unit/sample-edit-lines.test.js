import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sampleProductInput } from '../../src/samples/input.js';
import { sampleProductsUpdateInput, temporarySampleOrders } from '../../src/samples/lines-input.js';

function line() {
  return { id: randomUUID(), productId: randomUUID(), sampleCategoryId: randomUUID(), quantity: '1.000000000000001', description: '',
    tests: [{ id: randomUUID(), testParameterId: randomUUID(), methodId: randomUUID(), requestedQuantity: 1, rate: '0', currencyCode: 'INR' }] };
}

test('edit input preserves exact values, canonicalizes IDs and leaves new identities to the server', () => {
  const original = line(); const input = structuredClone(original);
  for (const key of ['id', 'productId', 'sampleCategoryId']) input[key] = input[key].toUpperCase();
  for (const key of ['id', 'testParameterId', 'methodId']) input.tests[0][key] = input.tests[0][key].toUpperCase();
  const [result] = sampleProductsUpdateInput([input], original.sampleCategoryId);
  assert.equal(result.id, original.id); assert.equal(result.productId, original.productId);
  assert.equal(result.tests[0].id, original.tests[0].id); assert.equal(result.tests[0].testParameterId, original.tests[0].testParameterId);
  assert.equal(result.quantity, original.quantity); assert.equal(result.description, ''); assert.equal(result.tests[0].rate, '0');
  delete input.id; delete input.tests[0].id;
  const [fresh] = sampleProductsUpdateInput([input], original.sampleCategoryId);
  assert.equal(fresh.id, null); assert.equal(fresh.tests[0].id, null);
  assert.throws(() => sampleProductInput(original, original.sampleCategoryId), { code: 'invalid_input' });
});

test('edit input rejects duplicate identities, invalid text, quantities and unsupported metadata', () => {
  const original = line(); const duplicate = structuredClone(original); duplicate.id = duplicate.id.toUpperCase();
  assert.throws(() => sampleProductsUpdateInput([original, duplicate]));
  duplicate.id = randomUUID(); assert.throws(() => sampleProductsUpdateInput([original, duplicate]));
  for (const value of [null, [], Array.from({ length: 101 }, line)]) assert.throws(() => sampleProductsUpdateInput(value));
  for (const patch of [{ id: '' }, { id: false }, { sampleId: randomUUID() }, { productRevision: 1 }, { customFields: [{ id: randomUUID() }] },
    { imageFileId: randomUUID() }, { description: '\ud800' }, { description: 'Bad\0text' }, { quantity: '0' }, { tests: [] }]) {
    assert.throws(() => sampleProductsUpdateInput([{ ...line(), ...patch }]));
  }
  for (const patch of [{ id: '' }, { sampleProductId: randomUUID() }, { requestedSize: '\udfff' }, { rate: '-1e-999' }, { rate: '-1' },
    { requestedQuantity: 0 }, { isAccredited: 'true' }, { estimatedDurationMinutes: -1 }, { status: 'requested' }]) {
    const input = line(); Object.assign(input.tests[0], patch); assert.throws(() => sampleProductsUpdateInput([input]));
  }
});

test('edit bounds permit 5,000 tests and reject both aggregate and per-line overflow', () => {
  const lines = Array.from({ length: 100 }, () => ({ ...line(), tests: Array.from({ length: 50 }, () => line().tests[0]) }));
  assert.equal(sampleProductsUpdateInput(lines).flatMap(item => item.tests).length, 5000);
  lines[0].tests.push(line().tests[0]); assert.throws(() => sampleProductsUpdateInput(lines));
  assert.throws(() => sampleProductsUpdateInput([{ ...line(), tests: Array.from({ length: 1001 }, () => line().tests[0]) }]));
});

test('temporary positions support reorders, sparse imports and the maximum integer position', () => {
  const rows = [0, 1, 4, 5, 2_147_483_647].map(displayOrder => ({ id: randomUUID(), displayOrder }));
  const result = temporarySampleOrders(rows, 3);
  assert.deepEqual(result.map(row => row.displayOrder), [3, 6, 7, 8, 9]);
  assert.deepEqual(result.map(row => row.id), rows.map(row => row.id));
  assert.equal(new Set(result.map(row => row.displayOrder)).size, rows.length);
  assert.deepEqual(temporarySampleOrders([], 0), []);
});
