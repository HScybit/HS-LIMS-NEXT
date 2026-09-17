import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readMasterBulkUpload } from '../../src/masters/bulk-upload.js';
import { writeMasterXlsx } from '../../src/masters/bulk-xlsx-export.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { masterWorkbook } from '../helpers/master-workbooks.js';

function request(body, headers = {}, resource = 'products') {
  const url = new URL(`http://localhost/api/master-bulk?resource=${resource}`);
  const result = new Request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'source.csv',
    'x-upload-request-id': randomUUID(), 'x-upload-time-zone': 'Asia/Kolkata', ...headers }, body });
  Object.defineProperty(result, 'nextUrl', { value: url }); return result;
}

test('upload reader preserves CSV bytes/hash and raw values, and validates actual XLSX files through the worker', async () => {
  const source = '\uFEFF name,key\r\n Water ,01'; const csv = await readMasterBulkUpload(request(source));
  assert.equal(csv.input.format, 'csv'); assert.equal(csv.input.sourceSha256, createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(csv.decoded.rows[0].values, [' Water ', '01']);
  const bytes = await masterWorkbook([['name', 'uuid', 'parse_num'], ['A', 'A', { formula: 'FALSE()', result: false }]]);
  const xlsx = await readMasterBulkUpload(request(bytes, { 'x-file-name': encodeURIComponent('Typed values.XLSX') }, 'methods'));
  assert.equal(xlsx.input.format, 'xlsx'); assert.equal(xlsx.decoded.rows[0].values[2], false);
});

test('upload reader rejects wrong resource, type, length, encoding, name, size and missing bodies', async () => {
  const source = 'name,key\nA,A';
  for (const [body, headers, resource] of [
    [source, {}, 'users'], [source, { 'content-type': 'application/json' }], [source, { 'x-file-name': 'source.xls' }],
    [source, { 'x-file-name': '%broken' }], [source, { 'x-file-name': '' }], [source, { 'content-length': '-1' }],
    [source, { 'content-length': '999' }], [source, { 'content-length': '16777217' }], [null, {}],
    [Buffer.from([0xc0, 0xaf]), {}], [source, { 'x-upload-time-zone': 'Unknown/Zone' }], [source, { 'x-upload-request-id': 'bad' }],
  ]) await assert.rejects(readMasterBulkUpload(request(body, headers, resource)), error => [400, 413, 415].includes(error.status));
  await assert.rejects(readMasterBulkUpload(request(Buffer.alloc(16 * 1_048_576 + 1))), { code: 'bulk_file_limit' });
});

test('export worker retains scalars/dates and formula-looking text as literal non-executable cells', async () => {
  const date = new Date('2026-09-17T18:30:00.000Z');
  const rows = [['=1+1', false, 0, date], ['+SUM(A1)', true, 1, ''], ['@name', false, -1, '']];
  const bytes = await writeMasterXlsx(['text', 'boolean', 'number', 'date'], rows);
  const decoded = await decodeMasterXlsx(bytes);
  assert.deepEqual(decoded.rows.map(row => row.values), rows);
  assert.equal(decoded.rows.flatMap(row => row.cellMetadata).filter(cell => cell.type === 'formula' || cell.type === 'hyperlink').length, 0);
  assert.deepEqual(rows[0], ['=1+1', false, 0, date]);
});

test('export validates bounded values and permits an empty sample workbook without data rows', async () => {
  assert((await writeMasterXlsx(['name', 'key'], [])).length > 0);
  for (const [headers, rows] of [[[], []], [['a'], [['b', 'c']]], [['a'], [[{}]]], [['a'], [[Infinity]]], [['a'], [[new Date('invalid')]]],
    [['a'], [['a'.repeat(16001)]]], [['a'], [[String.fromCharCode(0xd800)]]], [['a'], [['nul\0']]]]) {
    await assert.rejects(writeMasterXlsx(headers, rows), error => error.status === 400);
  }
  await assert.rejects(writeMasterXlsx(['a'], Array.from({ length: 1100 }, () => ['x'.repeat(16000)])), { code: 'bulk_export_limit' });
});
