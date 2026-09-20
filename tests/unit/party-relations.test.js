import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { partySaveInput } from '../../src/masters/party-input.js';
import { customerAddressFields, partyContactFields, resolvePartyRelations } from '../../src/masters/party-relations.js';

function fixture() {
  const addresses = [
    { id: randomUUID(), addressType: 'shipping', attentionTo: 'Receiving', line1: 'Building 1', line2: null, city: 'Town', state: null,
      postalCode: null, countryCode: 'IN', freeformAddress: null, isDefault: true },
    { id: randomUUID(), addressType: 'shipping', attentionTo: null, line1: null, line2: null, city: null, state: null,
      postalCode: null, countryCode: null, freeformAddress: 'Second shipping site', isDefault: false },
  ];
  const contacts = [
    { id: randomUUID(), name: 'Primary', email: 'primary@example.invalid', phone: '0001', designation: 'Buyer', isPrimary: true },
    { id: randomUUID(), name: 'Second', email: 'second@example.invalid', phone: '0002', designation: null, isPrimary: false },
  ];
  return Object.freeze({ code: 'CUSTOMER', name: 'Customer', legalName: 'Legal name', addresses: Object.freeze(addresses.map(Object.freeze)),
    contacts: Object.freeze(contacts.map(Object.freeze)), ...customerAddressFields(addresses), ...partyContactFields(contacts) });
}
const command = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 1, ...changes });
const edit = (existing, changes) => resolvePartyRelations('customer', partySaveInput('customer', command(changes), existing), existing);

test('unchanged form addresses retain structured columns, stable IDs, contact details and extra relations', () => {
  const existing = fixture(); const result = edit(existing, { ...customerAddressFields(existing.addresses), ...partyContactFields(existing.contacts) });
  assert.deepEqual(result.addresses, existing.addresses); assert.deepEqual(result.contacts, existing.contacts);
  assert.notEqual(result.addresses[0], existing.addresses[0]);
  assert.equal(customerAddressFields(result.addresses).shipToAddress, 'Receiving, Building 1, Town, IN');
});

test('changed form addresses convert only the selected record to freeform and preserve its ID', () => {
  const existing = fixture(); const result = edit(existing, { shipToAddress: 'Changed shipping\nBay 3' });
  assert.equal(result.addresses[0].id, existing.addresses[0].id); assert.equal(result.addresses[0].freeformAddress, 'Changed shipping\nBay 3');
  assert.equal(result.addresses[0].city, null); assert.equal(result.addresses[0].countryCode, null);
  assert.deepEqual(result.addresses[1], existing.addresses[1]); assert.deepEqual(result.contacts, existing.contacts);
});

test('clearing one shown address or contact preserves remaining relations; explicit empty lists clear them all', () => {
  const existing = fixture(); const cleared = edit(existing, { shipToAddress: '', contactPersonName: '', contactPersonEmail: '', contactPersonPhone: '' });
  assert.deepEqual(cleared.addresses, [existing.addresses[1]]); assert.deepEqual(cleared.contacts, [existing.contacts[1]]);
  assert.deepEqual(customerAddressFields(cleared.addresses), { shipToAddress: 'Second shipping site', billToAddress: null });
  assert.deepEqual(edit(existing, { addresses: [], contacts: [] }), { addresses: [], contacts: [] });
});

test('primary contact edits preserve designation, stable identity and other contacts', () => {
  const existing = fixture(); const changed = edit(existing, { contactPersonName: 'Renamed' });
  assert.deepEqual(changed.contacts[0], { ...existing.contacts[0], name: 'Renamed' });
  assert.deepEqual(changed.contacts[1], existing.contacts[1]);
  assert.deepEqual(changed.addresses, existing.addresses);
});

test('new form relations allocate IDs only when needed and do not invent blank addresses', () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()]; let allocated = 0;
  const input = partySaveInput('customer', { ...command({}), revision: 0, name: 'Customer', legalName: 'Legal',
    shipToAddress: 'Shipping', billToAddress: '', contactPersonName: 'Contact', contactPersonPhone: '0001' });
  const result = resolvePartyRelations('customer', input, {}, { newId: () => ids[allocated++] });
  assert.equal(allocated, 2); assert.equal(result.contacts[0].id, ids[0]); assert.equal(result.addresses[0].id, ids[1]);
  assert.equal(result.contacts[0].isPrimary, true); assert.equal(result.addresses[0].isDefault, true); assert.equal(result.addresses.length, 1);
  const existing = { name: 'Customer', legalName: 'Legal', code: 'CUSTOMER', ...result, ...partyContactFields(result.contacts), ...customerAddressFields(result.addresses) };
  const repeated = resolvePartyRelations('customer', partySaveInput('customer', { ...command({}), revision: 0, name: 'Customer', legalName: 'Legal',
    shipToAddress: 'Shipping', billToAddress: '', contactPersonName: 'Contact', contactPersonPhone: '0001' }, existing), existing,
  { newId: () => assert.fail('An unchanged relation must retain its ID') });
  assert.deepEqual(repeated, result);
});

test('complete lists retain their validated order and Vendor contacts have no invented designation', () => {
  const contact = { id: randomUUID(), name: 'Vendor contact', email: 'vendor@example.invalid', phone: '0001', isPrimary: true };
  const input = partySaveInput('vendor', { ...command({}), revision: 0, name: 'Vendor', legalName: 'Legal', contacts: [contact] });
  assert.deepEqual(resolvePartyRelations('vendor', input), { contacts: [contact] });
  assert.deepEqual(partyContactFields([]), { contactPersonName: null, contactPersonEmail: null, contactPersonPhone: null });
  assert.deepEqual(customerAddressFields([]), { shipToAddress: null, billToAddress: null });
  assert.throws(() => resolvePartyRelations('constructor', input), TypeError);
});
