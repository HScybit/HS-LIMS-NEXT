import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { masterBulkXlsxLimits as limits } from '../../src/masters/bulk-xlsx-limits.js';
import { masterWorkbook, workbookArchive, workbookParts } from '../helpers/master-workbooks.js';

const invalid = (buffer, message) => assert.rejects(() => decodeMasterXlsx(buffer), error => (
  error.status === 400 && error.code === 'invalid_bulk_workbook' && (!message || message.test(error.message))
));

test('XLSX decoding preserves raw scalar types, formula zero/false and both date systems', async () => {
  const date = new Date('2026-09-16T18:30:00.000Z');
  for (const date1904 of [false, true]) {
    const file = await masterWorkbook([
      [' name ', 'number', 'boolean', 'date', 'zero', 'false', 'text', 'literal'],
      [' Water ', 0, false, date, { formula: '1-1', result: 0 }, { formula: 'FALSE()', result: false }, '001.00', '=1+1'],
    ], workbook => { workbook.properties.date1904 = date1904; });
    const result = await decodeMasterXlsx(file);
    assert.deepEqual(result.headers, ['name', 'number', 'boolean', 'date', 'zero', 'false', 'text', 'literal']);
    assert.equal(result.sourceHeaders[0], ' name '); assert.equal(result.date1904, date1904);
    assert.deepEqual(result.rows[0].values, [' Water ', 0, false, date, 0, false, '001.00', '=1+1']);
    assert.deepEqual(result.rows[0].cellMetadata.filter(cell => cell.type === 'formula'), [
      { columnNumber: 5, type: 'formula', formula: '1-1', hasResult: true },
      { columnNumber: 6, type: 'formula', formula: 'FALSE()', hasResult: true },
    ]);
    assert.equal(result.sheetName, 'First'); assert.equal(result.headerRowNumber, 1);
    assert(result.expandedBytes > file.length); assert(result.decodedBytes > 0);
  }
});

test('XLSX decoding uses the first worksheet and preserves physical row gaps', async () => {
  const file = await masterWorkbook([], (workbook, sheet) => {
    sheet.getCell('A3').value = 'name'; sheet.getCell('A5').value = 'First'; sheet.getCell('A9').value = 'Last';
    workbook.addWorksheet('Second').addRows([['name'], ['Ignored']]);
  });
  const result = await decodeMasterXlsx(file);
  assert.equal(result.sheetCount, 2); assert.equal(result.headerRowNumber, 3);
  assert.deepEqual(result.rows.map(row => [row.rowNumber, row.values]), [[5, ['First']], [9, ['Last']]]);
});

test('XLSX decoding retains rich text, hyperlink labels and number formats without following links', async () => {
  const file = await masterWorkbook([
    ['rich', 'link', 'number'],
    [{ richText: [{ text: ' Rich ' }, { text: 'text ' }] }, { text: ' Link ', hyperlink: 'https://example.invalid/reference' }, 12],
  ], (_workbook, sheet) => { sheet.getCell('C2').numFmt = '0000'; });
  const result = await decodeMasterXlsx(file);
  assert.deepEqual(result.rows[0].values, [' Rich text ', ' Link ', 12]);
  assert.deepEqual(result.rows[0].cellMetadata, [
    { columnNumber: 1, type: 'rich_text' },
    { columnNumber: 2, type: 'hyperlink', hyperlink: 'https://example.invalid/reference' },
    { columnNumber: 3, type: 'formatted', numberFormat: '0000' },
  ]);
});

test('XLSX error cells and formulas without cached results survive as rows requiring correction', async () => {
  const file = await masterWorkbook([['value'], [{ formula: 'NOW()' }], [{ error: '#DIV/0!' }], [{ formula: '1/0', result: { error: '#DIV/0!' } }]]);
  const result = await decodeMasterXlsx(file);
  assert.deepEqual(result.rows.map(row => row.values), [[''], [''], ['']]);
  assert.deepEqual(result.rows.map(row => row.cellMetadata), [
    [{ columnNumber: 1, type: 'formula', formula: 'NOW()', hasResult: false }],
    [{ columnNumber: 1, type: 'error', errorCode: '#DIV/0!' }],
    [{ columnNumber: 1, type: 'formula', formula: '1/0', hasResult: true, errorCode: '#DIV/0!' }],
  ]);
});

test('XLSX headers retain formula provenance and reject invalid or duplicate bindings', async () => {
  const formulaHeader = await decodeMasterXlsx(await masterWorkbook([[{ formula: '"name"', result: 'name' }], ['A']]));
  assert.deepEqual(formulaHeader.headerCellMetadata, [{ columnNumber: 1, type: 'formula', formula: '"name"', hasResult: true }]);
  for (const rows of [[['name', ' name '], ['A', 'B']], [['name', '', 'key'], ['A', '', 'a']], [[0], ['A']], [[false], ['A']], [[{ formula: '"name"' }], ['A']]]) {
    await invalid(await masterWorkbook(rows));
  }
  const header = 'h'.repeat(limits.headerCharacters);
  assert.deepEqual((await decodeMasterXlsx(await masterWorkbook([[header], ['A']]))).headers, [header]);
  await invalid(await masterWorkbook([[header + 'h'], ['A']]), /250 characters/);
});

test('XLSX decoding requires data and rejects values or errors in unheaded columns', async () => {
  await invalid(await masterWorkbook([])); await invalid(await masterWorkbook([['name']]));
  await invalid(await masterWorkbook([['name'], ['A', 0]]), /without a header/);
  await invalid(await masterWorkbook([['name'], ['A', false]]), /without a header/);
  await invalid(await masterWorkbook([['name'], ['A', { error: '#VALUE!' }]]), /without a header/);
  await invalid(await masterWorkbook([['name'], ['A', { formula: 'NOW()' }]]), /without a header/);
  const valid = await decodeMasterXlsx(await masterWorkbook([['name', 'description'], ['A'], ['B', '  '], ['0'], [false]]));
  assert.deepEqual(valid.rows.map(row => row.values), [['A', ''], ['B', '  '], ['0', ''], [false, '']]);
});

test('XLSX data-row bounds count actual records and preserve bounded sparse positions', async () => {
  const rows = Array.from({ length: limits.rows }, (_, index) => [`row-${index}`]);
  assert.equal((await decodeMasterXlsx(await masterWorkbook([['name'], ...rows]))).rows.length, 2500);
  await invalid(await masterWorkbook([['name'], ...rows, ['extra']]), /2,500 data rows/);
  const sparse = await masterWorkbook([['name']], (_workbook, sheet) => { sheet.getCell(`A${limits.worksheetRows}`).value = 'Last'; });
  assert.equal((await decodeMasterXlsx(sparse)).rows[0].rowNumber, 10000);
  await invalid(await masterWorkbook([['name']], (_workbook, sheet) => { sheet.getCell('A10001').value = 'Too far'; }), /10,000 row positions/);
});

test('XLSX column bounds cover dense and sparse worksheet layouts', async () => {
  const headers = Array.from({ length: limits.columns }, (_, index) => `column_${index}`);
  const row = Array(limits.columns).fill('value');
  assert.equal((await decodeMasterXlsx(await masterWorkbook([headers, row]))).rows[0].values.length, 250);
  await invalid(await masterWorkbook([[...headers, 'extra'], [...row, 'extra']]));
  await invalid(await masterWorkbook([['name'], ['A']], (_workbook, sheet) => { sheet.getCell('IV2').value = 'Far column'; }), /250 columns/);
});

test('XLSX decoded cell and aggregate value limits apply even to reused shared strings', async () => {
  const value = 'x'.repeat(limits.cellCharacters);
  assert.equal((await decodeMasterXlsx(await masterWorkbook([['name'], [value]]))).rows[0].values[0], value);
  await invalid(await masterWorkbook([['name'], [value + 'x']]), /16,000 characters/);
  await invalid(await masterWorkbook([['name'], [{ richText: [{ text: value }, { text: 'x' }] }]]), /16,000 characters/);
  await invalid(await masterWorkbook([['name'], ...Array.from({ length: 1100 }, () => [value])]), /Decoded workbook values/);
});

test('XLSX decoding rejects wrong input types, missing parts, truncation and oversized files', async () => {
  for (const value of [null, undefined, 'text', new Uint8Array([1]), Buffer.alloc(0), Buffer.alloc(limits.bytes + 1)]) await invalid(value);
  await invalid(Buffer.from('not an XLSX archive'));
  await invalid(workbookArchive([{ name: 'text.txt', data: 'text' }]), /not an XLSX/);
  const valid = await masterWorkbook([['name'], ['A']]); await invalid(valid.subarray(0, valid.length - 4));
});

test('XLSX archive limits reject excessive entry counts and declared expansion before loading', async () => {
  await invalid(workbookArchive(Array.from({ length: limits.archiveEntries + 1 }, (_, index) => ({ name: `entry-${index}` }))), /too many archive entries/);
  await invalid(workbookArchive([...workbookParts(), { name: 'large.xml', declaredSize: limits.expandedBytes + 1 }]), /expanded workbook/);
  await invalid(workbookArchive([...workbookParts(), { name: 'large1.xml', declaredSize: 33 * 1024 * 1024 }, { name: 'large2.xml', declaredSize: 33 * 1024 * 1024 }]), /expanded workbook/);
});

test('XLSX archive validation checks actual size and CRC instead of trusting metadata', async () => {
  await invalid(workbookArchive([...workbookParts(), { name: 'forged.xml', data: 'x'.repeat(4096), declaredSize: 1 }]));
  await invalid(workbookArchive([...workbookParts(), { name: 'forged.xml', data: 'x'.repeat(4096), declaredSize: 8192 }]));
  await invalid(workbookArchive([...workbookParts(), { name: 'damaged.xml', data: 'actual content', crc: 0 }]), /damaged archive data/);
});

test('XLSX archive validation rejects duplicate paths, encryption and unsupported compression', async () => {
  await invalid(workbookArchive([...workbookParts(), { name: 'same.xml' }, { name: 'same.xml' }]), /ambiguous/);
  for (const name of ['xl/./workbook.xml', '../outside.xml', 'xl\\workbook.xml', 'xl//sheet.xml']) {
    await invalid(workbookArchive([...workbookParts(), { name }]));
  }
  await invalid(workbookArchive([...workbookParts(), { name: 'encrypted.xml', flags: 0x801 }]), /unencrypted/);
  await invalid(workbookArchive([...workbookParts(), { name: 'unsupported.xml', method: 99 }]), /compression/);
});
