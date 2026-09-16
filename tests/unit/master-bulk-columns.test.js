import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bindMasterBulkColumns as bind } from '../../src/masters/bulk-columns.js';
import { parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { masterWorkbook } from '../helpers/master-workbooks.js';

const field = (extra = {}) => ({ id: randomUUID(), revision: 2, key: 'serial', associatedWith: 'product', ...extra });
const fields = (resource, headers) => bind(resource, headers).map(column => column.fieldName);
const invalid = callback => assert.throws(callback, { status: 400, code: 'invalid_bulk_columns' });

test('bulk columns bind actual Meteor and PERN master template headers to native fields', () => {
  assert.deepEqual(fields('products', ['name', 'description', 'abbr', 'key', 'job_template_id']), ['name', 'description', 'abbreviation', 'key', 'jobTemplateId']);
  assert.deepEqual(fields('products', ['name', 'description', 'abbreviation', 'key', 'jobTemplateId', 'tagIds']), ['name', 'description', 'abbreviation', 'key', 'jobTemplateId', 'tagIds']);
  assert.deepEqual(fields('test-parameters', ['order', 'name', 'description', 'key', 'lab', 'scheme_abbr']), ['order', 'name', 'description', 'key', 'laboratoryId', 'schemeAbbreviation']);
  assert.deepEqual(fields('test-parameters', ['order', 'name', 'description', 'key', 'laboratoryId', 'schemeAbbreviation']), ['order', 'name', 'description', 'key', 'laboratoryId', 'schemeAbbreviation']);
  assert.deepEqual(fields('methods', ['name', 'uuid', 'description', 'decimal_places', 'parse_num']), ['name', 'uuid', 'description', 'decimalScale', 'parseNumber']);
  assert.deepEqual(fields('methods', ['name', 'uuid', 'description', 'decimalScale', 'parseNumber', 'accessUserIds']), ['name', 'uuid', 'description', 'decimalScale', 'parseNumber', 'accessUserIds']);
  assert.deepEqual(fields('test-parameters', ['lab_id']), ['laboratoryId']);
  assert.deepEqual(fields('methods', ['user_access']), ['accessUserIds']);
});

test('bulk columns keep the source MoA normalization and literal Product/Parameter names', () => {
  assert.deepEqual(bind('methods', [' MoA Name ', 'Decimal Places', 'PARSE_NUM']), [
    { columnNumber: 1, header: ' MoA Name ', key: 'moa_name', kind: 'master', fieldName: 'name' },
    { columnNumber: 2, header: 'Decimal Places', key: 'decimal_places', kind: 'master', fieldName: 'decimalScale' },
    { columnNumber: 3, header: 'PARSE_NUM', key: 'parse_num', kind: 'master', fieldName: 'parseNumber' },
  ]);
  assert.deepEqual(fields('products', [' name ']), ['name']);
  invalid(() => bind('products', ['NAME'])); invalid(() => bind('test-parameters', ['Scheme Abbreviation']));
  const definition = field({ associatedWith: 'method_of_analysis' });
  assert.equal(bind('methods', ['PROJECT_FIELD.Serial'], [definition])[0].fieldKey, 'serial');
  invalid(() => bind('methods', ['project_field.Serial'], [definition]));
});

test('bulk columns reject duplicate aliases instead of choosing the first or last value', () => {
  for (const [resource, headers] of [
    ['products', ['abbr', 'abbreviation']], ['products', ['jobTemplateId', 'job_template_id']],
    ['products', ['name', ' name ']], ['test-parameters', ['lab', 'lab_id']],
    ['test-parameters', ['lab', 'laboratoryId']], ['test-parameters', ['scheme_abbr', 'schemeAbbreviation']],
    ['methods', ['name', 'MoA Name']], ['methods', ['parse_num', 'parseNumber']],
    ['methods', ['decimalScale', 'Decimal Places']], ['methods', ['user_access', 'accessUserIds']],
    ['methods', ['name', 'NAME']], ['methods', ['isActive', 'isactive']],
  ]) invalid(() => bind(resource, headers));
});

test('bulk columns retain exact custom-field identity, revision and source position', () => {
  const definition = Object.freeze(field()); const headers = Object.freeze(['description', 'project_field.serial', 'key']);
  const definitions = Object.freeze([definition]);
  const result = bind('products', headers, definitions);
  assert.deepEqual(result[1], { columnNumber: 2, header: 'project_field.serial', key: 'project_field.serial', kind: 'custom_field',
    fieldId: definition.id, fieldRevision: 2, fieldKey: 'serial' });
  result[1].fieldRevision = 99; assert.equal(definition.revision, 2);
  invalid(() => bind('products', ['project_field.unknown'], definitions));
  invalid(() => bind('products', ['anything.serial'], definitions));
  invalid(() => bind('products', ['project_field.nested.serial'], definitions));
  invalid(() => bind('products', ['project_field.serial', ' project_field.serial '], definitions));
});

test('bulk columns reject incomplete, stale, foreign-association and ambiguous definition sets', () => {
  const base = field();
  const badSets = [null, {}, [null], Array(1), [field({ associatedWith: 'parameter' })], [field({ active: false })],
    [field({ id: 'not-an-id' })], [field({ revision: 0 })], [field({ revision: 2_147_483_648 })], [field({ revision: '2' })],
    [field({ key: '' })], [field({ key: 'a'.repeat(151) })], [field({ key: 'not.a.key' })],
    [base, field()], [base, { ...base, key: 'other' }], [base, { ...base, id: base.id.toUpperCase(), key: 'other' }]];
  for (const definitions of badSets) assert.throws(() => bind('products', ['name'], definitions), { status: 409, code: 'invalid_bulk_definitions' });
  const boundary = field({ revision: 2_147_483_647, key: 'a'.repeat(150) });
  assert.equal(bind('products', ['project_field.' + boundary.key], [boundary])[0].fieldRevision, boundary.revision);
});

test('bulk columns identify the established ignored columns without mapping their values', () => {
  assert.equal(bind('products', ['line_items'])[0].kind, 'ignored');
  assert(bind('test-parameters', ['product_id', 'parent_id', 'isActive', 'min', 'formula', 'template_id', 'specification_data']).every(column => column.kind === 'ignored' && !Object.hasOwn(column, 'fieldName')));
  assert(bind('methods', ['Est Time', 'isActive', 'associated_instruments', 'base_unit']).every(column => column.kind === 'ignored'));
  invalid(() => bind('products', ['line_items', 'line_items']));
});

test('bulk columns never turn arbitrary or protected headers into master properties', () => {
  for (const resource of ['products', 'test-parameters', 'methods']) {
    for (const header of ['__proto__', 'constructor', 'toString', 'organization_id', 'id', 'requestId', 'revision', 'created_at', 'customFields']) {
      invalid(() => bind(resource, [header]));
    }
  }
  for (const [resource, header] of [['products', 'sample_category_ids'], ['products', 'discipline_id'], ['test-parameters', 'moa_applicable'], ['methods', 'master_template']]) invalid(() => bind(resource, [header]));
});

test('bulk columns enforce input shape and header limits including sparse arrays', () => {
  for (const resource of [null, {}, '__proto__', 'constructor', 'customers', 'product']) invalid(() => bind(resource, ['name']));
  for (const headers of [null, {}, 'name', [], Array(1), [null], [1], [''], [' '], ['a\0b'], ['\ud800'], ['a'.repeat(251)], [' '.repeat(16000) + 'name']]) invalid(() => bind('products', headers));
  assert.throws(() => bind('products', ['a'.repeat(250)]), /not supported/);
});

test('bulk columns accept 250 positions and 500 scoped definitions without modifying them', () => {
  const definitions = Array.from({ length: 500 }, (_, index) => field({ key: `field_${index}` }));
  const headers = definitions.slice(0, 250).map(definition => 'project_field.' + definition.key);
  const before = structuredClone(definitions);
  const result = bind('products', headers, definitions);
  assert.equal(result.length, 250); assert.equal(result.at(-1).columnNumber, 250);
  assert.equal(result.at(-1).fieldId, definitions[249].id); assert.deepEqual(definitions, before);
  invalid(() => bind('products', [...headers, 'name'], definitions));
  assert.throws(() => bind('products', ['name'], [...definitions, field({ key: 'extra' })]), { code: 'invalid_bulk_definitions' });
});

test('bulk column binding never fills omitted columns or chooses a requiredness policy', () => {
  for (const resource of ['products', 'test-parameters', 'methods']) {
    assert.deepEqual(bind(resource, ['description']), [{ columnNumber: 1, header: 'description', key: 'description', kind: 'master', fieldName: 'description' }]);
  }
});

test('bulk column binding works with decoded CSV while leaving source values and lines intact', () => {
  const decoded = parseMasterBulkCsv('\nname,abbr,key\n Water ,W,001\n'); const before = structuredClone(decoded);
  const columns = bind('products', decoded.headers);
  assert.deepEqual(columns.map(column => column.fieldName), ['name', 'abbreviation', 'key']);
  assert.equal(decoded.rows[0].rowNumber, 3); assert.deepEqual(decoded.rows[0].values, [' Water ', 'W', '001']);
  assert.deepEqual(decoded, before);
  const duplicate = parseMasterBulkCsv('abbr,abbreviation\nA,B'); invalid(() => bind('products', duplicate.headers));
});

test('bulk column binding works with real XLSX dates, zero/false and explicit formula metadata', async () => {
  const definition = field({ associatedWith: 'method_of_analysis' }); const date = new Date('2026-09-17T00:00:00Z');
  const file = await masterWorkbook([['MoA Name', 'uuid', 'Decimal Places', 'parse_num', 'project_field.serial'],
    ['Method', '001', 0, { formula: 'FALSE()', result: false }, date]]);
  const decoded = await decodeMasterXlsx(file); const before = structuredClone(decoded);
  const columns = bind('methods', decoded.headers, [definition]);
  assert.deepEqual(columns.slice(0, 4).map(column => column.fieldName), ['name', 'uuid', 'decimalScale', 'parseNumber']);
  assert.equal(columns[4].fieldId, definition.id); assert.deepEqual(decoded.rows[0].values, ['Method', '001', 0, false, date]);
  assert.deepEqual(decoded, before);
});
