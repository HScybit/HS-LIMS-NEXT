import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductGeneration } from '../../src/custom-fields/product-generation-runner.js';

const data = (scheme = 'P/{{scheme_counter}}') => ({
  fields: [{ id: 'first', key: 'first', label: 'First', fieldType: 'text', options: [], scheme, generatedAt: 'on_init', paddedNumber: 2, splitter: '/' },
    { id: 'second', key: 'second', label: 'Second', fieldType: 'text', options: [], scheme: '{{first}}/second', generatedAt: 'on_submit' }],
  values: { first: '', second: '' }, doc: { project_field_data: { first: { value: '', display_value: '' }, second: { value: '', display_value: '' } } },
  settings: {}, counts: { products: 0, samples: 0 }, clock: { year: 2026, month: 9, day: 13, timestamp: 0 }, timeZone: null, fieldId: null, mode: 'create',
});

test('generation worker scans ordered pages, retains full cursors and feeds generated values into later fields', async () => {
  const cursor = { productId: 'product', createdAt: '2026-09-13 00:00:00.000001+00', updatedAt: '2026-09-13 00:00:00.000002+00' };
  const calls = [];
  const values = await runProductGeneration(data(), async (fieldId, after) => {
    calls.push({ fieldId, after });
    return after ? [{ ...cursor, value: 'P/0012' }] : [{ ...cursor, value: 'unrelated' }];
  });
  assert.deepEqual(calls, [{ fieldId: 'first', after: null }, { fieldId: 'first', after: cursor }]);
  assert.deepEqual(values, [{ fieldId: 'first', value: 'P/0013' }, { fieldId: 'second', value: 'P/0013/second' }]);
  const edit = data(); edit.mode = 'edit';
  assert.deepEqual(await runProductGeneration(edit, async () => { throw new Error('No On Init generation on edits'); }), [{ fieldId: 'second', value: '/second' }]);
});

test('generation worker rejects invalid patterns and preserves database errors without a fallback number', async () => {
  await assert.rejects(runProductGeneration(data('[{{scheme_counter}}'), async () => []), { code: 'invalid_scheme' });
  const failure = new Error('Synthetic history failure');
  await assert.rejects(runProductGeneration(data(), async () => { throw failure; }), (error) => error === failure);
  const supplied = data('X'); supplied.values.first = 'kept'; supplied.values.second = 'kept';
  assert.deepEqual(await runProductGeneration(supplied, async () => { throw failure; }), []);
});

test('a pathological scheme times out in its worker while the main event loop remains responsive', async () => {
  let ticks = 0; let read = false; const timer = setInterval(() => ticks++, 20);
  try {
    await assert.rejects(runProductGeneration(data('(a+)+Z{{scheme_counter}}'), async () => {
      read = true; return [{ value: 'a'.repeat(100000), productId: 'product', createdAt: '2026-09-13', updatedAt: '2026-09-13' }];
    }, { timeoutMs: 1500 }), { code: 'scheme_timeout' });
    assert.equal(read, true); assert.ok(ticks >= 10, 'the caller event loop kept running');
  } finally { clearInterval(timer); }
});

test('generation does not release a pending database read when its worker deadline expires', async () => {
  let readFinished = false;
  await assert.rejects(runProductGeneration(data(), async () => {
    await new Promise((resolve) => setTimeout(resolve, 1700)); readFinished = true; return [];
  }, { timeoutMs: 1500 }), { code: 'scheme_timeout' });
  assert.equal(readFinished, true);
});
