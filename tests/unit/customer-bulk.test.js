import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bindMasterBulkColumns } from '../../src/masters/bulk-columns.js';
import { masterBulkRowCommand, requiredBulkColumns } from '../../src/masters/bulk-row.js';
import { partySaveInput } from '../../src/masters/party-input.js';
import { customerBulkHeaders } from '../../src/masters/customer-bulk-config.js';
import { allowedMasterBulkResources } from '../../src/masters/bulk-config.js';

async function command(headers, values, definitions = [], cellMetadata = []) {
  return masterBulkRowCommand({ resource: 'customers', columns: bindMasterBulkColumns('customers', headers, definitions),
    row: { values, cellMetadata }, definitions, id: randomUUID(), requestId: randomUUID(), timeZone: 'Asia/Kolkata' });
}

test('Customer source columns and native aliases bind without accepting metadata or duplicate aliases', () => {
  assert.equal(customerBulkHeaders.length, 19);
  const columns = bindMasterBulkColumns('customers', customerBulkHeaders);
  assert.equal(new Set(columns.map(column => column.fieldName)).size, 19);
  assert.doesNotThrow(() => requiredBulkColumns('customers', columns));
  assert.doesNotThrow(() => requiredBulkColumns('customers', bindMasterBulkColumns('customers', ['displayName', 'legalName'])));
  for (const header of ['_id', 'organization_id', 'inserted_by', 'isActive', 'code']) {
    assert.throws(() => bindMasterBulkColumns('customers', ['name', 'legal_name', header]), { code: 'invalid_bulk_columns' });
  }
  assert.throws(() => bindMasterBulkColumns('customers', ['name', 'legal_name', 'legalName']), { code: 'invalid_bulk_columns' });
  assert.throws(() => requiredBulkColumns('customers', bindMasterBulkColumns('customers', ['name'])), { code: 'missing_bulk_columns' });
});

test('Customer bulk blanks use API defaults, supplied zero/false and exact decimal strings survive', async () => {
  const headers = ['name', 'legal_name', 'default_credit_period', 'igst', 'customer_total_balance', 'isFeedback', 'status'];
  const defaults = partySaveInput('customer', await command(headers, [' Defaults ', ' Legal ', '', '', '', '', '']));
  assert.equal(defaults.name, 'Defaults'); assert.equal(defaults.creditDays, 0); assert.equal(defaults.igstPercent, '18');
  assert.equal(defaults.totalBalance, '0'); assert.equal(defaults.feedbackApplicable, false); assert.equal(defaults.active, true);
  const explicit = partySaveInput('customer', await command(headers, ['Zero', 'Legal', 0, '0', '-12.3450000001', 'false', 'inactive']));
  assert.equal(explicit.creditDays, 0); assert.equal(explicit.igstPercent, '0'); assert.equal(explicit.totalBalance, '-12.3450000001');
  assert.equal(explicit.feedbackApplicable, false); assert.equal(explicit.active, false);
});

test('Customer bulk rejects invalid native numeric, boolean, contact and required values', async () => {
  for (const [header, value] of [['default_credit_period', '1.5'], ['default_credit_period', '3651'], ['igst', '100.000000001'],
    ['igst', 'NaN'], ['customer_total_balance', 'Infinity'], ['isFeedback', 'maybe'], ['contact_person_email', 'invalid'], ['legal_name', '']]) {
    const headers = ['name', 'legal_name']; const values = ['Name', 'Legal'];
    if (header === 'legal_name') values[1] = value; else { headers.push(header); values.push(value); }
    await assert.rejects(async () => partySaveInput('customer', await command(headers, values)));
  }
  await assert.rejects(command(['name', 'legal_name', 'igst'], ['Name', 'Legal', false]), /must be a number/);
});

test('Customer custom cells retain dates, false and multiple selections while spreadsheet errors block', async () => {
  const definitions = [['date', 'date_time'], ['flag', 'checkbox'], ['users', 'multi_user_select']].map(([key, fieldType]) => ({
    id: randomUUID(), revision: 1, key, label: key, associatedWith: 'customer', fieldType,
  }));
  const headers = ['name', 'legal_name', ...definitions.map(field => `project_field.${field.key}`)];
  const value = await command(headers, ['Name', 'Legal', new Date('2026-09-17T00:00:00Z'), false, 'A;B|A'], definitions);
  assert.deepEqual(value.customFields.map(field => field.value), ['2026-09-17T00:00:00.000Z', false, ['A', 'B']]);
  assert.equal(value.customFieldTimeZone, 'Asia/Kolkata');
  await assert.rejects(command(headers, ['Name', 'Legal'], definitions, [{ columnNumber: 1, type: 'formula', formula: 'NOW()', hasResult: false }]), /spreadsheet/);
  assert.throws(() => bindMasterBulkColumns('customers', headers, definitions.map(field => ({ ...field, associatedWith: 'product' }))), { code: 'invalid_bulk_definitions' });
});

test('Customer upload selection requires both management permission and configured module access', () => {
  assert.equal(allowedMasterBulkResources(['masters.manage']).includes('customers'), false);
  assert.equal(allowedMasterBulkResources(['masters.read'], { customer: true }).includes('customers'), false);
  assert.equal(allowedMasterBulkResources(['users.manage'], { customer: true }).includes('customers'), false);
  assert.equal(allowedMasterBulkResources(['masters.manage'], { customer: true }).includes('customers'), true);
});
