import test from 'node:test';
import assert from 'node:assert/strict';
import { masterBulkExampleRow } from '../../src/masters/bulk-examples.js';
import { masterBulkResources } from '../../src/masters/bulk-config.js';
import { csvDocument, dataTransferAccess } from '../../src/masters/data-transfer.js';

test('every sample workbook header receives an example value', () => {
  for (const [resource, config] of Object.entries(masterBulkResources)) {
    const row = masterBulkExampleRow(resource, config.headers);
    assert.equal(row.length, config.headers.length, resource);
    row.forEach((value, index) => assert.ok(typeof value === 'string' && value.trim(), `${resource}.${config.headers[index]}`));
  }
  assert.deepEqual(masterBulkExampleRow('products', ['name', 'key', 'abbr']), ['Example Product', 'example_product', 'PXX']);
  assert.equal(masterBulkExampleRow('methods', ['name'])[0], 'Example Method of Analysis');
});

test('custom field example values follow the definition type', () => {
  const fields = [{ key: 'grade', label: 'Grade', fieldType: 'select', options: [{ value: 'A' }, { value: 'B' }] },
    { key: 'tested_on', label: 'Tested On', fieldType: 'date' }, { key: 'notes', label: 'Notes', fieldType: 'text' }];
  assert.deepEqual(masterBulkExampleRow('products', ['project_field.grade', 'project_field.tested_on', 'project_field.notes', 'project_field.unknown'], fields),
    ['A', '2026-01-01', 'Example Notes', 'Example value']);
});

test('csv export quotes values, doubles quotes and neutralizes formula prefixes', () => {
  const csv = csvDocument(['Name', 'Note'], [['Water', 'Say "hi"'], ['=SUM(A1)', null], ['-1', 3]]);
  assert.equal(csv, '﻿"Name","Note"\r\n"Water","Say ""hi"""\r\n"\'=SUM(A1)",""\r\n"\'-1","3"\r\n');
});

test('data transfer access separates staged imports from read-only exports', () => {
  assert.deepEqual(dataTransferAccess(['masters.read'], {}), { importable: [], exportable: ['products', 'test-parameters', 'methods'] });
  assert.deepEqual(dataTransferAccess(['masters.read', 'masters.manage'], { customer: true }),
    { importable: ['products', 'test-parameters', 'methods', 'customers'], exportable: ['products', 'test-parameters', 'methods', 'customers'] });
  assert.deepEqual(dataTransferAccess(['users.manage'], {}), { importable: ['users'], exportable: [] });
  assert.deepEqual(dataTransferAccess([], {}), { importable: [], exportable: [] });
});
