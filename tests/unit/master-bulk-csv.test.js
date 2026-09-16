import test from 'node:test';
import assert from 'node:assert/strict';
import { masterBulkCsvLimits, parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';

const invalid = (input, message) => assert.throws(() => parseMasterBulkCsv(input), error => (
  error.status === 400 && error.code === 'invalid_bulk_csv' && (!message || message.test(error.message))
));

test('bulk CSV preserves source text, raw headers and physical row numbers', () => {
  const result = parseMasterBulkCsv('\uFEFF\r\n name ,key,description,\r\n\r\n Water ,01," line one\r\nline two ",\r\nOil,02,\r\n');
  assert.deepEqual(result, {
    headerRowNumber: 2,
    headers: ['name', 'key', 'description'],
    sourceHeaders: [' name ', 'key', 'description', ''],
    rows: [
      { rowNumber: 4, values: [' Water ', '01', ' line one\r\nline two ', ''] },
      { rowNumber: 6, values: ['Oil', '02', ''] },
    ],
  });
});

test('bulk CSV supports each line ending and quoted delimiters, quotes and newlines', () => {
  for (const ending of ['\n', '\r', '\r\n']) {
    const result = parseMasterBulkCsv(`name,description${ending}"Water, milk","He said ""yes"".${ending}Next line"${ending}Second,final`);
    assert.deepEqual(result.rows, [
      { rowNumber: 2, values: ['Water, milk', `He said "yes".${ending}Next line`] },
      { rowNumber: 4, values: ['Second', 'final'] },
    ]);
  }
});

test('CSV values that resemble scientific data, booleans, dates or formulas remain strings', () => {
  const values = ['0', '-0', 'false', 'TRUE', '001.00', '9007199254740993', '1e300', '2026-09-17', '=1+1', '+SUM(A1)', '@name'];
  const result = parseMasterBulkCsv(`value\n${values.join('\n')}`);
  assert.deepEqual(result.rows.map(row => row.values[0]), values);
  assert(result.rows.every(row => typeof row.values[0] === 'string'));
});

test('short records, trailing empty cells and whitespace retain their source shape', () => {
  assert.deepEqual(parseMasterBulkCsv('name,key,description\nA\nB,,\n" C " \t,key,,').rows, [
    { rowNumber: 2, values: ['A'] },
    { rowNumber: 3, values: ['B', '', ''] },
    { rowNumber: 4, values: [' C  \t', 'key', '', ''] },
  ]);
  assert.deepEqual(parseMasterBulkCsv('name\n""\n \t\n0\nfalse\n').rows, [
    { rowNumber: 4, values: ['0'] }, { rowNumber: 5, values: ['false'] },
  ]);
});

test('bulk CSV rejects missing data, blank interior headers and duplicate trimmed headers', () => {
  for (const input of ['', '\uFEFF', ' \r\n,\n""', 'name', 'name\n', 'name\n,\n', 'name\n""']) {
    invalid(input, /header and at least one data row/);
  }
  invalid('name,,key\nA,,a', /Header cells cannot be blank/);
  invalid('name, name \nA,B', /header must be unique/);
  assert.deepEqual(parseMasterBulkCsv('name,key,,\nA,a,,').headers, ['name', 'key']);
});

test('unheaded values are rejected without dropping source columns', () => {
  invalid('name,key\nA,a,unexpected', /Row 2.*without a header/);
  invalid('name,key,\nA,a,false', /without a header/);
  invalid('name,key\nA,a,0', /without a header/);
  assert.deepEqual(parseMasterBulkCsv('name,key\nA,a, \t,').rows[0].values, ['A', 'a', ' \t', '']);
});

test('malformed quotes produce bounded source-row diagnostics', () => {
  invalid('name\n"unterminated', /Row 2, column 1.*unterminated/);
  invalid('name\n"multi\nline', /Row 2, column 1.*unterminated/);
  invalid('name\npre"fix', /unexpected quote/);
  invalid('name\n "value"', /unexpected quote/);
  invalid('name\n"value"junk', /text after its closing quote/);
  invalid('name\n"value" "next"', /unexpected quote/);
  assert.equal(parseMasterBulkCsv('name\n"a""b"').rows[0].values[0], 'a"b');
});

test('bulk CSV enforces the data-row limit after blank records are removed', () => {
  const rows = Array.from({ length: masterBulkCsvLimits.rows }, (_, index) => `name${index}`);
  const result = parseMasterBulkCsv(`name\n\n${rows.join('\n\n')}\n`);
  assert.equal(result.rows.length, 2500);
  assert.equal(result.rows.at(-1).rowNumber, 5001);
  invalid(`name\n${rows.join('\n')}\none more`, /2,500 data rows/);
});

test('bulk CSV enforces column limits on every record, including trailing empty cells', () => {
  const headers = Array.from({ length: masterBulkCsvLimits.columns }, (_, index) => `column_${index}`).join(',');
  const values = Array(masterBulkCsvLimits.columns).fill('value').join(',');
  assert.equal(parseMasterBulkCsv(`${headers}\n${values}`).rows[0].values.length, 250);
  invalid(`${headers},extra\n${values}`, /Row 1.*250 columns/);
  invalid(`${headers}\n${values},`, /Row 2.*250 columns/);
  invalid(`name\n${','.repeat(250)}`, /Row 2.*250 columns/);
});

test('bulk CSV enforces header and decoded-cell length boundaries', () => {
  const header = 'h'.repeat(masterBulkCsvLimits.headerCharacters);
  const value = 'x'.repeat(masterBulkCsvLimits.cellCharacters);
  assert.equal(parseMasterBulkCsv(`${header}\n${value}`).rows[0].values[0], value);
  invalid(`${header}h\nA`, /headers must be 250 characters/);
  invalid(`name\n${value}x`, /Row 2, column 1.*16,000 characters/);
  assert.equal(parseMasterBulkCsv(`name\n"${'""'.repeat(16000)}"`).rows[0].values[0], '"'.repeat(16000));
  invalid(`name\n"${'""'.repeat(16001)}"`, /16,000 characters/);
  invalid(`name\n"${'x'.repeat(15999)}\r\n"`, /16,000 characters/);
});

test('bulk CSV validates input types and Unicode without silently replacing text', () => {
  for (const value of [null, undefined, 0, false, [], {}, new String('name\nA')]) invalid(value, /Provide CSV text/);
  for (const input of ['name\nA\0B', 'name\n\ud800', 'name\n\udfff']) invalid(input, /invalid text/);
  assert.equal(parseMasterBulkCsv('name\nपानी 🧪').rows[0].values[0], 'पानी 🧪');
});

test('bulk CSV bounds encoded bytes as well as JavaScript string length', () => {
  invalid('x'.repeat(masterBulkCsvLimits.bytes + 1), /16 MiB/);
  invalid('é'.repeat(masterBulkCsvLimits.bytes / 2 + 1), /16 MiB/);
  // An exact-limit valid file uses bounded fields and rows, rather than a single oversized cell.
  const header = Array.from({ length: 250 }, (_, index) => `h${index}`).join(',') + '\n';
  const data = [];
  let remaining = masterBulkCsvLimits.bytes - header.length;
  while (remaining > 0) {
    const recordBytes = Math.min(16001, remaining);
    data.push('a'.repeat(recordBytes - 1) + '\n');
    remaining -= recordBytes;
  }
  const input = header + data.join('');
  assert.equal(new TextEncoder().encode(input).byteLength, masterBulkCsvLimits.bytes);
  assert.equal(parseMasterBulkCsv(input).rows.length, data.length);
  invalid(input + '\n', /16 MiB/);
});
