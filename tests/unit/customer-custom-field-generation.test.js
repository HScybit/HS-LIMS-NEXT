import test from 'node:test';
import assert from 'node:assert/strict';
import { customerGenerationInput } from '../../src/masters/customer-custom-field-generation.js';
import { generateCustomerScheme } from '../../src/custom-fields/product-generation.js';
import { runMasterGeneration } from '../../src/custom-fields/product-generation-runner.js';

test('Customer generation uses its visible name, abbreviation, zeroes and count', async () => {
  const value = await generateCustomerScheme({ field: { scheme: '{{customer_name}}/{{customer_abbr}}/{{entity.customer_total_balance}}/{{entity.default_credit_period}}/{{total_counter}}/{{product_name}}/{{samples_counter}}' },
    doc: { name: 'Client', abbr: 'CL', customer_total_balance: 0, default_credit_period: 0 }, counts: { customers: 7, samples: 4 }, settings: { nonNablStartNumber: '9tail' } });
  assert.equal(value, 'Client/CL/0/0/16//5');
});

test('Customer generation accepts incomplete form drafts without accepting hidden context', () => {
  const input = { customer: { name: '', totalBalance: 0, creditDays: '', feedbackApplicable: false }, customFields: [] };
  const command = customerGenerationInput(input);
  assert.equal(command.doc.customer_total_balance, 0); assert.equal(command.doc.default_credit_period, ''); assert.equal(command.doc.isFeedback, false);
  assert.equal(command.doc.igst, 18); assert.equal(command.doc.status, 'active');
  for (const extra of [{ organizationId: 'foreign' }, { totalBalance: Infinity }, { creditDays: {} }, { status: 'deleted' }, { name: '\0' }, { feedbackApplicable: 0 }]) {
    assert.throws(() => customerGenerationInput({ ...input, customer: { ...input.customer, ...extra } }), { code: 'invalid_input' });
  }
});

test('Customer schemes execute in the existing bounded worker and feed subsequent fields', async () => {
  const fields = [{ id: 'first', key: 'first', label: 'First', fieldType: 'text', scheme: '{{customer_abbr}}/{{total_counter}}', generatedAt: 'on_init' },
    { id: 'second', key: 'second', label: 'Second', fieldType: 'text', scheme: '{{first}}/next', generatedAt: 'on_submit' }];
  const result = await runMasterGeneration({ kind: 'customer', fields, values: { first: '', second: '' }, doc: { abbr: 'CL', project_field_data: { first: {}, second: {} } },
    counts: { customers: 4 }, mode: 'create', timeZone: null }, async () => { throw new Error('No counter history read expected'); });
  assert.deepEqual(result, [{ fieldId: 'first', value: 'CL/5' }, { fieldId: 'second', value: 'CL/5/next' }]);
});
