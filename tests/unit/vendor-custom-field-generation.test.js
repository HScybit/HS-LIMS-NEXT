import test from 'node:test';
import assert from 'node:assert/strict';
import { vendorGenerationInput } from '../../src/masters/vendor-custom-field-generation.js';
import { generateVendorScheme } from '../../src/custom-fields/product-generation.js';
import { runMasterGeneration } from '../../src/custom-fields/product-generation-runner.js';

test('Vendor generation preserves source generic tokens, zero and real Vendor counters', async () => {
  const value = await generateVendorScheme({ field: { scheme: '{{entity.name}}/{{abbr}}/{{entity.vendor_total_balance}}/{{total_counter}}/{{vendor_name}}/{{samples_counter}}' },
    doc: { name: 'Supplier', abbr: 'VN', vendor_total_balance: 0 }, counts: { vendors: 7, samples: 4 }, settings: { nonNablStartNumber: '9tail' } });
  assert.equal(value, 'Supplier/VN/0/16//5');
});

test('Vendor generation accepts an incomplete visible draft and rejects hidden or malformed fields', () => {
  const input = { vendor: { name: '', totalBalance: 0 }, customFields: [] }; const command = vendorGenerationInput(input);
  assert.equal(command.doc.vendor_total_balance, 0); assert.equal(command.doc.contact_person_email, '');
  assert.equal(Object.hasOwn(command.doc, 'status'), false);
  for (const extra of [{ organizationId: 'foreign' }, { status: 'inactive' }, { creditDays: 0 }, { totalBalance: Infinity }, { totalBalance: {} }, { name: '\0' }]) {
    assert.throws(() => vendorGenerationInput({ ...input, vendor: { ...input.vendor, ...extra } }), { code: 'invalid_input' });
  }
});

test('Vendor schemes execute in the bounded worker and feed subsequent fields', async () => {
  const fields = [{ id: 'first', key: 'first', label: 'First', fieldType: 'text', scheme: '{{abbr}}/{{total_counter}}', generatedAt: 'on_init' },
    { id: 'second', key: 'second', label: 'Second', fieldType: 'text', scheme: '{{first}}/next', generatedAt: 'on_submit' }];
  const result = await runMasterGeneration({ kind: 'vendor', fields, values: { first: '', second: '' }, doc: { abbr: 'VN', project_field_data: { first: {}, second: {} } },
    counts: { vendors: 4 }, mode: 'create', timeZone: null }, async () => { throw new Error('No counter history read expected'); });
  assert.deepEqual(result, [{ fieldId: 'first', value: 'VN/5' }, { fieldId: 'second', value: 'VN/5/next' }]);
});
