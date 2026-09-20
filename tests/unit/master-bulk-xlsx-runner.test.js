import test from 'node:test';
import assert from 'node:assert/strict';
import { readMasterXlsx } from '../../src/masters/bulk-xlsx-runner.js';
import { masterBulkXlsxLimits as limits } from '../../src/masters/bulk-xlsx-limits.js';
import { masterWorkbook } from '../helpers/master-workbooks.js';

test('XLSX worker returns real decoded values and owns its input bytes', async () => {
  const date = new Date('2026-09-17T00:00:00Z');
  const file = await masterWorkbook([['name', 'date', 'cached'], ['A', date, { formula: '1-1', result: 0 }]]);
  const originalLength = file.byteLength;
  const pending = readMasterXlsx(file);
  file.fill(0);
  const result = await pending;
  assert.deepEqual(result.rows[0].values, ['A', date, 0]);
  assert.equal(file.byteLength, originalLength);
  assert(file.every(value => value === 0));
});

test('XLSX worker reads only the supplied view and supports owned ArrayBuffers', async () => {
  const file = await masterWorkbook([['name'], ['A']]);
  const container = Buffer.concat([Buffer.from('prefix'), file, Buffer.from('suffix')]);
  assert.equal((await readMasterXlsx(container.subarray(6, 6 + file.length))).rows[0].values[0], 'A');
  const arrayBuffer = new Uint8Array(file).buffer;
  assert.equal((await readMasterXlsx(arrayBuffer)).rows[0].values[0], 'A');
  assert.equal(arrayBuffer.byteLength, file.length);
});

test('XLSX worker admission is bounded and releases slots after successful reads', async () => {
  const file = await masterWorkbook([['name'], ['A']]);
  const first = readMasterXlsx(file); const second = readMasterXlsx(file);
  await assert.rejects(readMasterXlsx(file), { status: 429, code: 'workbook_reader_busy' });
  await Promise.all([first, second]);
  assert.equal((await readMasterXlsx(file)).rows[0].values[0], 'A');
});

test('XLSX worker errors and timeouts release slots while the caller remains responsive', async () => {
  const file = await masterWorkbook([['name'], ['A']]);
  await assert.rejects(readMasterXlsx(Buffer.from('bad workbook')), { code: 'invalid_bulk_workbook' });
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try {
    await assert.rejects(readMasterXlsx(file, { timeoutMs: 20 }), { status: 422, code: 'workbook_read_timeout' });
    assert(ticks > 0, 'the caller event loop remained responsive');
  } finally { clearInterval(timer); }
  const results = await Promise.all([readMasterXlsx(file), readMasterXlsx(file)]);
  assert(results.every(result => result.rows[0].values[0] === 'A'));
});

test('XLSX worker rejects invalid inputs and deadlines before allocating a reader slot', async () => {
  for (const input of [null, undefined, '', [], Buffer.alloc(0), Buffer.alloc(limits.bytes + 1), new DataView(new ArrayBuffer(4)), new Uint8Array(new SharedArrayBuffer(4))]) {
    await assert.rejects(readMasterXlsx(input), { status: 400, code: 'invalid_bulk_workbook' });
  }
  const file = await masterWorkbook([['name'], ['A']]);
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, limits.timeoutMs + 1, '10']) {
    await assert.rejects(readMasterXlsx(file, { timeoutMs }), { status: 400, code: 'invalid_workbook_timeout' });
  }
  assert.equal((await readMasterXlsx(file)).rows[0].values[0], 'A');
});
