import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bindMasterBulkColumns } from '../../src/masters/bulk-columns.js';
import { masterBulkRowCommand, requiredBulkColumns } from '../../src/masters/bulk-row.js';
import { partySaveInput } from '../../src/masters/party-input.js';
import { vendorBulkHeaders } from '../../src/masters/vendor-bulk-config.js';
import { allowedMasterBulkResources } from '../../src/masters/bulk-config.js';

const required = ['name', 'legal_name', 'contact_person_name', 'contact_person_email', 'contact_person_phone'];
const base = ['Name', 'Legal', 'Contact', 'contact@example.invalid', '123'];
async function command(headers, values, definitions = [], cellMetadata = []) {
  return masterBulkRowCommand({ resource: 'vendors', columns: bindMasterBulkColumns('vendors', headers, definitions),
    row: { values, cellMetadata }, definitions, id: randomUUID(), requestId: randomUUID(), timeZone: 'Asia/Kolkata' });
}

test('Vendor sample headers and optional source/native aliases bind while metadata and duplicate aliases reject', () => {
  assert.equal(vendorBulkHeaders.length, 7); assert.doesNotThrow(() => requiredBulkColumns('vendors', bindMasterBulkColumns('vendors', vendorBulkHeaders)));
  assert.doesNotThrow(() => requiredBulkColumns('vendors', bindMasterBulkColumns('vendors', ['displayName', 'legalName', 'contactPersonName', 'contactPersonEmail', 'contactPersonPhone', 'abbreviation', 'totalBalance'])));
  for (const header of ['_id', 'organization_id', 'inserted_by', 'isActive', 'code', 'ship_to_address']) assert.throws(() => bindMasterBulkColumns('vendors', [...required, header]), { code: 'invalid_bulk_columns' });
  assert.throws(() => bindMasterBulkColumns('vendors', [...required, 'legalName']), { code: 'invalid_bulk_columns' });
  for (const omitted of required) assert.throws(() => requiredBulkColumns('vendors', bindMasterBulkColumns('vendors', required.filter(header => header !== omitted))), { code: 'missing_bulk_columns' });
});

test('Vendor bulk defaults optional blanks and retains supplied zero, status, abbreviation and exact decimals', async () => {
  const headers = [...required, 'vendor_total_balance', 'status', 'abbr'];
  const defaults = partySaveInput('vendor', await command(headers, [...base, '', '', '']));
  assert.equal(defaults.totalBalance, '0'); assert.equal(defaults.active, true); assert.equal(defaults.abbreviation, null);
  const explicit = partySaveInput('vendor', await command(headers, [...base, '-12.3450000001', 'inactive', 'VN']));
  assert.equal(explicit.totalBalance, '-12.3450000001'); assert.equal(explicit.active, false); assert.equal(explicit.abbreviation, 'VN');
  assert.equal(partySaveInput('vendor', await command(headers, [...base, 0, 'active', ''])).totalBalance, '0');
});

test('Vendor bulk rejects malformed balances, contacts, required values and unsupported status', async () => {
  for (const [header, value] of [['vendor_total_balance', 'Infinity'], ['status', 'deleted'], ['contact_person_email', 'invalid'], ['contact_person_phone', ''], ['legal_name', '']]) {
    const headers = [...required]; const values = [...base]; const index = headers.indexOf(header);
    if (index >= 0) values[index] = value; else { headers.push(header); values.push(value); }
    await assert.rejects(async () => partySaveInput('vendor', await command(headers, values)));
  }
  await assert.rejects(command([...required, 'vendor_total_balance'], [...base, false]), /must be a number/);
});

test('Vendor custom cells preserve typed dates, false and multiple selections while spreadsheet errors block', async () => {
  const definitions = [['date', 'date_time'], ['flag', 'checkbox'], ['users', 'multi_user_select']].map(([key, fieldType]) => ({
    id: randomUUID(), revision: 1, key, label: key, associatedWith: 'vendor', fieldType,
  }));
  const headers = [...required, ...definitions.map(field => `project_field.${field.key}`)];
  const value = await command(headers, [...base, new Date('2026-09-17T00:00:00Z'), false, 'A;B|A'], definitions);
  assert.deepEqual(value.customFields.map(field => field.value), ['2026-09-17T00:00:00.000Z', false, ['A', 'B']]); assert.equal(value.customFieldTimeZone, 'Asia/Kolkata');
  await assert.rejects(command(headers, base, definitions, [{ columnNumber: 1, type: 'formula', formula: 'NOW()', hasResult: false }]), /spreadsheet/);
  assert.throws(() => bindMasterBulkColumns('vendors', headers, definitions.map(field => ({ ...field, associatedWith: 'product' }))), { code: 'invalid_bulk_definitions' });
});

test('Vendor upload selection requires management permission and configured Vendor access', () => {
  for (const [permissions, modules] of [[['masters.manage'], {}], [['masters.read'], { vendor: true }], [['users.manage'], { vendor: true }], [['masters.manage'], { customer: true }]]) {
    assert.equal(allowedMasterBulkResources(permissions, modules).includes('vendors'), false);
  }
  assert.equal(allowedMasterBulkResources(['masters.manage'], { vendor: true }).includes('vendors'), true);
});
