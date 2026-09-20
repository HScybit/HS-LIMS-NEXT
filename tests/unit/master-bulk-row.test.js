import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bindMasterBulkColumns } from '../../src/masters/bulk-columns.js';
import { parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';
import { bulkBoolean, bulkDelimited, bulkCellValue, masterBulkRowCommand, requiredBulkColumns } from '../../src/masters/bulk-row.js';
import { productInput } from '../../src/masters/products.js';
import { methodInput } from '../../src/masters/methods.js';
import { testParameterInput } from '../../src/masters/test-parameters.js';

const field = (key, options = {}) => ({ id: randomUUID(), key, revision: 1, associatedWith: 'product', fieldType: 'text', label: key, ...options });
function args(headers, values, { resource = 'products', definitions = [], ...options } = {}) {
  return { resource, columns: bindMasterBulkColumns(resource, headers, definitions), row: { values }, definitions,
    id: randomUUID(), requestId: randomUUID(), timeZone: 'Asia/Kolkata', resolve: async () => { throw new Error('Unexpected reference'); }, ...options };
}

test('bulk commands preserve omitted ordinary and saved-key Custom Fields without mutating input', async () => {
  const definitions = [field('kept'), field('clear'), field('replaced')];
  const previous = { revision: 4, name: 'Water', key: 'W', description: 'Retained description', abbreviation: 'H2O', tagIds: [randomUUID()],
    jobTemplateId: randomUUID(), customFields: [{ key: 'kept', value: false }, { key: 'clear', value: 'clear me' },
      { fieldId: randomUUID(), key: 'replaced', value: ['0', 'A'] }] };
  const input = args(['key', 'project_field.clear'], [' W ', ' '], { definitions, previous });
  const before = structuredClone(input.previous);
  const result = productInput(await masterBulkRowCommand(input));
  assert.equal(result.revision, 4); assert.equal(result.description, 'Retained description'); assert.equal(result.abbreviation, 'H2O');
  assert.deepEqual(result.tagIds, previous.tagIds); assert.equal(result.jobTemplateId, previous.jobTemplateId);
  assert.deepEqual(result.customFields.map(entry => entry.value), [false, '', ['0', 'A']]);
  assert.deepEqual(previous, before);
});

test('explicit ordinary blanks clear values and new records retain native requiredness', async () => {
  const result = productInput(await masterBulkRowCommand(args(['key', 'description', 'abbr'], ['W', '', ''], {
    previous: { revision: 1, name: 'Water', description: 'Before', abbreviation: 'W' },
  })));
  assert.equal(result.description, ''); assert.equal(result.abbreviation, '');
  assert.throws(() => productInput({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'W' }), /Name/);
});

test('source-required headers accept mapped aliases but not missing Parameter or MoA columns', () => {
  for (const [resource, headers] of [['test-parameters', ['name', 'key', 'schemeAbbreviation']], ['methods', ['Moa Name', 'UUID', 'Parse Num']]]) {
    assert.doesNotThrow(() => requiredBulkColumns(resource, bindMasterBulkColumns(resource, headers)));
    assert.throws(() => requiredBulkColumns(resource, bindMasterBulkColumns(resource, headers.slice(0, 2))), { code: 'missing_bulk_columns' });
  }
});

test('CSV numeric/boolean coercion preserves false and zero and rejects nonnumeric values', async () => {
  const decoded = parseMasterBulkCsv('name,uuid,parse_num,decimal_places\nTest,M1,false,0');
  const result = methodInput(await masterBulkRowCommand(args(decoded.headers, decoded.rows[0].values, { resource: 'methods' })));
  assert.equal(result.parseNumber, false); assert.equal(result.decimalScale, 0);
  for (const value of ['NaN', 'Infinity', 'four', false]) {
    await assert.rejects(masterBulkRowCommand(args(decoded.headers, ['Test', 'M1', false, value], { resource: 'methods' })), /must be a number/);
  }
  for (const value of ['maybe', '', null]) assert.throws(() => bulkBoolean(value, 'Convert number'), /true or false/);
  for (const value of ['NO', 'off', '0', false, 0]) assert.equal(bulkBoolean(value, 'Boolean'), false);
  for (const value of ['YES', 'on', '1', true, 1]) assert.equal(bulkBoolean(value, 'Boolean'), true);
});

test('Parameter edits preserve the authored uncertainty grid when it has no upload column', async () => {
  const grid = { columns: [{ id: randomUUID(), title: 'Condition' }, { id: randomUUID(), title: 'Uncertainty' }],
    rows: [{ id: randomUUID(), values: ['0.2'] }] };
  const result = testParameterInput(await masterBulkRowCommand(args(['name', 'key', 'scheme_abbr', 'order'], ['New', 'P', 'PX', '0'], {
    resource: 'test-parameters', previous: { revision: 2, measurementUncertainty: grid, laboratoryId: null },
  })));
  assert.deepEqual(result.measurementUncertainty, grid); assert.equal(result.order, 0);
});

test('only explicit reference columns resolve and a blank single/multiple reference clears it', async () => {
  const calls = []; const first = randomUUID(); const second = randomUUID();
  const result = await masterBulkRowCommand(args(['name', 'key', 'tagIds', 'job_template_id'], ['A', 'a', ' Alpha;Beta|Alpha ', ''], {
    resolve: async (field, values) => { calls.push([field, values]); return [first, second]; },
  }));
  assert.deepEqual(calls, [['tagIds', ['Alpha', 'Beta']]]); assert.deepEqual(result.tagIds, [first, second]); assert.equal(result.jobTemplateId, null);
  assert.deepEqual(bulkDelimited(' A,B;C|A '), ['A', 'B', 'C']); assert.deepEqual(bulkDelimited(''), []);
});

test('typed date cells become explicit instants and omitted dates keep their saved interpretation zone', async () => {
  const definition = field('date', { fieldType: 'date' }); const date = new Date('2026-09-17T00:00:00.000Z');
  const supplied = await masterBulkRowCommand(args(['name', 'key', 'project_field.date'], ['A', 'a', date], { definitions: [definition] }));
  assert.equal(supplied.customFields[0].value, date.toISOString()); assert.equal(supplied.customFieldTimeZone, 'Asia/Kolkata');
  const omitted = await masterBulkRowCommand(args(['key'], ['a'], { definitions: [definition], previous: {
    revision: 1, name: 'A', customFields: [{ key: 'date', value: '17/09/2026' }], customFieldTimeZone: 'Europe/London',
  } }));
  assert.equal(omitted.customFieldTimeZone, 'Europe/London'); assert.equal(omitted.customFields[0].value, '17/09/2026');
  const otherDate = field('other_date', { fieldType: 'date' });
  const mixed = await masterBulkRowCommand(args(['key', 'project_field.other_date'], ['a', '18/09/2026'], { definitions: [definition, otherDate], previous: {
    revision: 1, name: 'A', customFields: [{ key: 'date', value: '17/09/2026' }], customFieldTimeZone: 'Europe/London',
  } }));
  assert.equal(mixed.customFieldTimeZone, 'Europe/London'); assert.equal(mixed.customFields[0].value, '17/09/2026');
  assert.throws(() => bulkCellValue(new Date('invalid')), { code: 'invalid_bulk_row' });
});

test('Custom Field multiple and checkbox CSV inputs use explicit values rather than string truthiness', async () => {
  const definitions = [field('enabled', { fieldType: 'checkbox' }), field('choices', { fieldType: 'select', allowsMultiple: true })];
  const result = await masterBulkRowCommand(args(['name', 'key', 'project_field.enabled', 'project_field.choices'], ['A', 'a', 'false', '0;A|B'], { definitions }));
  assert.deepEqual(result.customFields.map(entry => entry.value), [false, ['0', 'A', 'B']]);
});

test('uncached formulas and Excel errors block authoring until the affected cell is corrected', async () => {
  for (const metadata of [{ columnNumber: 1, type: 'formula', formula: 'NOW()', hasResult: false }, { columnNumber: 1, type: 'error', errorCode: '#VALUE!' }]) {
    await assert.rejects(masterBulkRowCommand(args(['name', 'key'], ['', 'a'], { row: { values: ['', 'a'], cellMetadata: [metadata] } })), /Correct the spreadsheet/);
  }
  const result = await masterBulkRowCommand(args(['name', 'uuid', 'parse_num'], ['A', 'a', false], { resource: 'methods',
    row: { values: ['A', 'a', false], cellMetadata: [{ columnNumber: 3, type: 'formula', hasResult: true, formula: 'FALSE()' }] } }));
  assert.equal(result.parseNumber, false);
});
