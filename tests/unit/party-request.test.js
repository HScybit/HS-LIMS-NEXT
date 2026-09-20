import test from 'node:test';
import assert from 'node:assert/strict';
import { partySaveInput } from '../../src/masters/party-input.js';
import { partyRequestFingerprint } from '../../src/masters/party-request.js';

const id = '89000000-0000-4000-8000-000000000001';
const requestId = '89000000-0000-4000-8000-000000000002';
const fingerprint = (raw, existing) => partyRequestFingerprint('customer', raw, partySaveInput('customer', raw, existing));

test('party retry fingerprints ignore property order and later changes to omitted values', () => {
  const raw = { id, requestId, revision: 1, contactPersonPhone: ' 123 ', totalBalance: '0' };
  const before = { name: 'A', legalName: 'A', contactPersonName: 'First', contactPersonEmail: 'a@example.com' };
  const later = { name: 'Renamed', legalName: 'B', contactPersonName: 'Second', contactPersonEmail: 'b@example.com' };
  assert.equal(fingerprint(raw, before), fingerprint(Object.fromEntries(Object.entries(raw).reverse()), later));
  assert.notEqual(fingerprint(raw, before), fingerprint({ ...raw, contactPersonPhone: '456' }, before));
  assert.match(fingerprint(raw, before), /^[a-f0-9]{64}$/);
});

test('party retry fingerprints distinguish omission, explicit values and relationship order', () => {
  const raw = { id, requestId, revision: 0, name: 'A', legalName: 'A' };
  assert.notEqual(fingerprint(raw), fingerprint({ ...raw, totalBalance: 0 }));
  assert.notEqual(fingerprint(raw), fingerprint({ ...raw, contacts: [] }));
  assert.notEqual(fingerprint(raw), fingerprint({ ...raw, status: 'inactive' }));
  const contacts = [{ id, name: 'One', email: 'one@example.com' }, { id: requestId, name: 'Two', phone: '234' }];
  assert.notEqual(fingerprint({ ...raw, contacts }), fingerprint({ ...raw, contacts: contacts.toReversed() }));
  assert.equal(fingerprint({ ...raw, name: ' A ' }), fingerprint(raw));
});

test('party retry fingerprints keep original decimal precision before database rounding', () => {
  const raw = { id, requestId, revision: 0, name: 'A', legalName: 'A', totalBalance: '1.001' };
  assert.notEqual(fingerprint(raw), fingerprint({ ...raw, totalBalance: '1.002' }));
  assert.notEqual(fingerprint(raw), fingerprint({ ...raw, requestId: id }));
  assert.throws(() => partyRequestFingerprint('unknown', raw, {}), TypeError);
});
