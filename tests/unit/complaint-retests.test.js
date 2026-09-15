import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { complaintRetestInput } from '../../src/samples/complaint-input.js';

test('complaint selections use canonical UUIDs without changing the supplied array', () => {
  const id = randomUUID(); const input = Object.freeze([id.toUpperCase()]);
  assert.deepEqual(complaintRetestInput(input), [id]); assert.equal(input[0], id.toUpperCase());
});

test('complaint selection rejects empty, malformed and duplicate identities', () => {
  const id = randomUUID();
  for (const input of [undefined, null, {}, '', [], [null], [1], [''], ['bad'], [{ id }], [id, id.toUpperCase()]]) {
    assert.throws(() => complaintRetestInput(input));
  }
});

test('complaint selection allows 5,000 distinct tests and rejects the next one', () => {
  const ids = Array.from({ length: 5001 }, (_, index) => `${index.toString(16).padStart(8, '0')}-1234-4000-8000-123456789abc`);
  assert.equal(complaintRetestInput(ids.slice(0, 5000)).length, 5000);
  assert.throws(() => complaintRetestInput(ids), { code: 'invalid_complaint_retest' });
});
