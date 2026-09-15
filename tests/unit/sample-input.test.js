import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sampleRegistrationInput } from '../../src/samples/input.js';

const input = () => ({ sampleCategoryId: randomUUID(), sampleType: 'internal', receivedAt: '2026-09-12T00:00:00+05:30',
  products: [{ productId: randomUUID(), tests: [{ testParameterId: randomUUID(), methodId: randomUUID() }] }] });

test('sample inputs preserve exact decimal strings, zero charges and explicit false while applying source defaults', () => {
  const value = input();
  value.products[0].quantity = '1.234567890123456789';
  Object.assign(value.products[0].tests[0], { rate: '0', currencyCode: 'inr', isAccredited: false });
  const result = sampleRegistrationInput(value);
  assert.equal(result.products[0].quantity, '1.234567890123456789');
  assert.equal(result.products[0].sampleCategoryId, value.sampleCategoryId);
  assert.equal(result.products[0].tests[0].rate, '0');
  assert.equal(result.products[0].tests[0].currencyCode, 'INR');
  assert.equal(result.products[0].tests[0].isAccredited, false);
  assert.equal(result.products[0].tests[0].requestedQuantity, 1);
  assert.equal(result.quantity, null);
});

test('registration rejects invalid dates, quantities, duplicate tests and silently discarded fields', () => {
  const cases = [
    (v) => { v.receivedAt = '2026-02-30T00:00:00Z'; }, (v) => { v.receivedAt = '2026-09-12T24:00:00Z'; },
    (v) => { v.receivedAt = '2026-09-12T12:00:00'; }, (v) => { v.dueAt = '2026-09-11T00:00:00Z'; },
    (v) => { v.quantity = 0; }, (v) => { v.quantity = Infinity; }, (v) => { v.products[0].quantity = ''; },
    (v) => { v.products[0].tests.push({ ...v.products[0].tests[0] }); }, (v) => { v.products[0].tests[0].requestedQuantity = 1.2; },
    (v) => { v.totalAmount = 0; }, (v) => { v.products[0].tests[0].isRetest = 'false'; }, (v) => { v.products = []; },
    (v) => { v.products[0].imageFileId = 'invalid'; }, (v) => { v.customFields = [{ fieldId: randomUUID(), value: false }]; },
    (v) => { v.organizationId = randomUUID(); },
  ];
  for (const change of cases) { const value = input(); change(value); assert.throws(() => sampleRegistrationInput(value)); }
});

test('customer, quality-control, ILC and complaint variants enforce their actual dependent fields', () => {
  for (const sampleType of ['customer', 'quality_control', 'interlaboratory', 'complaint']) {
    const value = { ...input(), sampleType };
    assert.throws(() => sampleRegistrationInput(value), { code: 'invalid_sample' });
    if (sampleType === 'customer') Object.assign(value, { customerId: randomUUID(), customerAddress: 'Synthetic address' });
    if (sampleType === 'quality_control') Object.assign(value, { iqcType: 'int_lab', participantCount: 2 });
    if (sampleType === 'interlaboratory') Object.assign(value, { ilcMode: 'organizer', participatingLabs: [{ laboratoryName: 'Synthetic participant' }] });
    if (sampleType === 'complaint') value.products[0].tests[0].isRetest = true;
    assert.equal(sampleRegistrationInput(value).sampleType, sampleType);
  }
  for (const extra of [{ iqcType: 'retest' }, { participantCount: 2 }, { ilcMode: 'participant' }, { participatingLabs: [{ laboratoryName: 'Lab' }] }]) {
    assert.throws(() => sampleRegistrationInput({ ...input(), ...extra }), { code: 'invalid_sample' });
  }
});
