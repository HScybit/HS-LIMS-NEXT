import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sampleHeaderRevision, sampleHeaderUpdateInput, validateSampleHeaderChanges } from '../../src/samples/update-input.js';

const parse = (input, type = 'internal') => sampleHeaderUpdateInput({ revision: 1, ...input }, type);
const existing = { sampleType: 'internal', customerId: null, customerQuotationId: null, customerAddress: null,
  receivedAt: new Date('2026-01-02T00:00:00Z'), dueAt: new Date('2026-01-04T00:00:00Z'), totalAmount: null, currencyCode: null };

test('header patches distinguish omission, null, blank, zero and exact numeric/UUID spelling', () => {
  const customerId = randomUUID();
  const result = parse({ customerId: customerId.toUpperCase(), customerAddress: ' Address ', customerReference: '', dueAt: null,
    quantity: '1.234567890123456789', totalAmount: '0', currencyCode: 'inr', storageLocation: null });
  assert.deepEqual(result, { revision: 1, changes: { customerId, customerAddress: 'Address', customerReference: '', dueAt: null,
    quantity: '1.234567890123456789', storageLocation: null, totalAmount: '0', currencyCode: 'INR' } });
  assert.deepEqual(parse({}), { revision: 1, changes: {} });
  assert.equal(parse({ receivedAt: '2026-01-02T05:30:00.123456+05:30' }).changes.receivedAt, '2026-01-02T05:30:00.123456+05:30');
  assert.equal(parse({ totalAmount: '-0e-100' }).changes.totalAmount, '-0e-100');
  assert.equal(parse({ description: 'Valid 🌡️ result' }).changes.description, 'Valid 🌡️ result');
});

test('locked special header fields are ignored before parsing while applicable remarks remain editable', () => {
  const input = { customerAddress: ' New address ', customerId: randomUUID(), receivedAt: 'invalid locked date', quantity: false,
    totalAmount: {}, currencyCode: 'invalid', receivedByName: [], modeOfReceipt: 'Courier', collectionDetails: 'Collected',
    amendmentRemarks: 'Amended', complaintRemarks: 'Complaint' };
  assert.deepEqual(parse(input, 'quality_control').changes, { customerAddress: 'New address' });
  assert.deepEqual(parse(input, 'complaint').changes, { customerAddress: 'New address', complaintRemarks: 'Complaint' });
  assert.deepEqual(parse(input, 'amendment').changes, { customerId: input.customerId, customerAddress: 'New address',
    modeOfReceipt: 'Courier', collectionDetails: 'Collected', amendmentRemarks: 'Amended' });
  assert.deepEqual(parse({ totalAmount: false }, 'quality_control').changes, {});
  assert.deepEqual(parse({ amendmentRemarks: 'Ignored', complaintRemarks: 'Ignored' }).changes, {});
  for (const type of ['customer', 'internal', 'proficiency', 'interlaboratory']) assert.equal(parse({ receivedByName: 'Receiver' }, type).changes.receivedByName, 'Receiver');
});

test('header input rejects invalid bodies, immutable/unsupported keys, malformed text, numbers and dates', () => {
  for (const body of [null, [], {}, { revision: 0 }, { revision: '1' }, { revision: 2_147_483_648 }, { revision: 1, organizationId: randomUUID() }]) {
    assert.throws(() => sampleHeaderRevision(body));
  }
  for (const input of [
    { sampleType: 'complaint' }, { sampleCategoryId: randomUUID() }, { sampleNumber: 'Changed' }, { registeredBy: randomUUID() },
    { products: [] }, { templateInstanceId: randomUUID() }, { customFields: [] }, { receivedAt: null }, { receivedAt: '2026-02-30T00:00:00Z' },
    { dueAt: '' }, { dueAt: '2026-01-02' }, { customerId: '' }, { quantity: '0' }, { quantity: Infinity }, { quantity: true },
    { totalAmount: '-1e-999' }, { totalAmount: '-0.001' }, { totalAmount: '' }, { currencyCode: 'US' }, { currencyCode: 123 },
    { customerAddress: undefined }, { description: '\ud800' }, { description: '\udc00' }, { description: 'NUL\0' }, { description: 'x'.repeat(5001) },
  ]) assert.throws(() => parse(input), JSON.stringify(input));
  assert.equal(sampleHeaderRevision({ revision: 2_147_483_647 }), 2_147_483_647);
});

test('cross-field checks use retained values and require complete customer, amount and date relationships', () => {
  const customer = { ...existing, sampleType: 'customer', customerId: randomUUID(), customerAddress: 'Existing', totalAmount: '10', currencyCode: 'INR' };
  assert.doesNotThrow(() => validateSampleHeaderChanges(customer, { description: '' }));
  assert.doesNotThrow(() => validateSampleHeaderChanges(existing, { dueAt: null, totalAmount: '0', currencyCode: 'INR' }));
  assert.doesNotThrow(() => validateSampleHeaderChanges(customer, { totalAmount: null, currencyCode: null }));
  assert.doesNotThrow(() => validateSampleHeaderChanges(existing, { receivedAt: '2026-01-04T05:30:00+05:30' }));
  for (const changes of [{ customerId: null }, { customerAddress: null }, { customerAddress: '  ' }, { totalAmount: null }, { currencyCode: null },
    { receivedAt: '2026-01-05T00:00:00Z' }, { dueAt: '2026-01-01T00:00:00Z' }]) {
    assert.throws(() => validateSampleHeaderChanges(customer, changes), { code: 'invalid_sample' });
  }
  assert.throws(() => validateSampleHeaderChanges(existing, { customerQuotationId: randomUUID() }), { code: 'invalid_sample' });
});
