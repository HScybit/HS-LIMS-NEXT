import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { customerAddressInput, generatedPartyCode, partyContactInput, partySaveInput } from '../../src/masters/party-input.js';

const command = () => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: ' Customer ', legalName: ' Legal name ' });
const vendor = () => ({ ...command(), contactPersonName: 'Contact', contactPersonEmail: 'contact@example.invalid', contactPersonPhone: '00123' });
const address = (changes = {}) => ({ id: randomUUID(), addressType: 'shipping', freeformAddress: 'Delivery\nReceiving bay', isDefault: true, ...changes });

test('party creation keeps PERN API defaults and explicit zero values', () => {
  const input = partySaveInput('customer', command());
  assert.equal(input.name, 'Customer'); assert.equal(input.legalName, 'Legal name'); assert.equal(input.code, 'CUSTOMER');
  assert.equal(input.creditDays, 0); assert.equal(input.totalBalance, '0'); assert.equal(input.igstPercent, '18');
  assert.equal(input.feedbackApplicable, false); assert.equal(input.isKaleenBandhu, false); assert.equal(input.active, true);
  const zero = partySaveInput('customer', { ...command(), creditDays: 0, totalBalance: 0, igstPercent: 0, discountPercent: 0 });
  assert.equal(zero.creditDays, 0); assert.equal(zero.igstPercent, '0'); assert.equal(zero.discountPercent, '0');
  assert.equal(partySaveInput('vendor', { ...vendor(), totalBalance: -1.005 }).totalBalance, '-1.005');
});

test('party numeric transport stays exact until the database applies its declared scale', () => {
  for (const raw of ['-1.005', '999999999999999999.99', '1e-10', '.005', '+001.2300']) {
    assert.equal(partySaveInput('customer', { ...command(), totalBalance: raw }).totalBalance, raw);
  }
  assert.equal(partySaveInput('customer', { ...command(), totalBalance: '  1.25 ' }).totalBalance, '1.25');
  for (const raw of [null, '', ' ', true, [], {}, NaN, Infinity, 'Infinity', '0x12', '2 pounds', '1e309']) {
    assert.throws(() => partySaveInput('customer', { ...command(), totalBalance: raw }));
  }
  for (const key of ['igstPercent', 'sgstPercent', 'cgstPercent', 'discountPercent']) {
    for (const raw of [-1, 101, '100.001', '100.0000000000000000000001', '-1e-999', null, false, '']) assert.throws(() => partySaveInput('customer', { ...command(), [key]: raw }));
    for (const raw of [0, 100, 0.005, '-0.000', '1e2', '0.1e3', '1000e-1', '100.00000', '1e-999']) assert.equal(partySaveInput('customer', { ...command(), [key]: raw })[key], String(raw));
  }
  for (const raw of [null, '', '30', -1, 3651, 1.5]) assert.throws(() => partySaveInput('customer', { ...command(), creditDays: raw }));
});

test('partial party edits preserve code, omitted values and unedited relationships', () => {
  const existing = Object.freeze({ code: 'ORIGINAL', name: 'Original name', legalName: 'Original legal', abbreviation: 'OLD', totalBalance: '-2.30',
    active: false, creditDays: 30, igstPercent: '0.0000', contactPersonName: 'Old contact', contactPersonEmail: 'old@example.invalid', contactPersonPhone: '0001' });
  const input = partySaveInput('customer', { id: randomUUID(), requestId: randomUUID(), revision: 1, name: 'Renamed' }, existing);
  assert.equal(input.code, 'ORIGINAL'); assert.equal(input.name, 'Renamed'); assert.equal(input.legalName, 'Original legal');
  assert.equal(input.totalBalance, '-2.30'); assert.equal(input.creditDays, 30); assert.equal(input.active, false); assert.equal(input.igstPercent, '0.0000');
  assert.equal(input.contactsProvided, false); assert.equal(input.flatContactProvided, false); assert.deepEqual(input.addressUpdates, {});
  const edited = partySaveInput('customer', { id: randomUUID(), requestId: randomUUID(), revision: 1, contactPersonName: 'New contact', shipToAddress: '' }, existing);
  assert.deepEqual(edited.contact, { name: 'New contact', email: existing.contactPersonEmail, phone: existing.contactPersonPhone });
  assert.deepEqual(edited.addressUpdates, { shipToAddress: null });
});

test('generated party codes follow the source normalizer and supplied codes remain validated', () => {
  assert.equal(generatedPartyCode('customer', '  a & b / 7  '), 'A-B-/-7');
  assert.equal(generatedPartyCode('customer', '測試'), 'CUSTOMER'); assert.equal(generatedPartyCode('vendor', ''), 'VENDOR');
  assert.equal(generatedPartyCode('vendor', 'a'.repeat(100)), 'A'.repeat(64));
  assert.equal(partySaveInput('customer', { ...command(), abbreviation: ' AB ' }).code, 'AB');
  assert.equal(partySaveInput('customer', { ...command(), code: 'CUSTOM-1' }).code, 'CUSTOM-1');
  for (const code of [null, '', ' spaced code ', '../prefix', 'a'.repeat(65)]) assert.throws(() => partySaveInput('customer', { ...command(), code }));
  assert.throws(() => generatedPartyCode('constructor', 'test'), TypeError);
});

test('party text, booleans, statuses and protected properties reject malformed inputs', () => {
  for (const key of ['name', 'legalName', 'abbreviation', 'taxIdentifier', 'defaultInvoiceNotes']) {
    for (const value of ['bad\0text', '\ud800', {}, 2]) assert.throws(() => partySaveInput('customer', { ...command(), [key]: value }));
  }
  for (const key of ['name', 'legalName']) for (const value of [null, '', ' ', 'x'.repeat(251)]) assert.throws(() => partySaveInput('customer', { ...command(), [key]: value }));
  for (const key of ['feedbackApplicable', 'isKaleenBandhu']) for (const value of [null, '', 0, 'false']) assert.throws(() => partySaveInput('customer', { ...command(), [key]: value }));
  for (const key of ['organizationId', 'savedBy', 'retired', 'active', 'createdAt']) assert.throws(() => partySaveInput('customer', { ...command(), [key]: randomUUID() }));
  for (const status of [null, '', 'Active', 'retired', true]) assert.throws(() => partySaveInput('customer', { ...command(), status }));
  assert.throws(() => partySaveInput('vendor', { ...vendor(), creditDays: 30 }));
  assert.throws(() => partySaveInput('constructor', command()), TypeError);
});

test('contact fields preserve leading zeroes and require consistent contact information', () => {
  assert.equal(partySaveInput('vendor', vendor()).contact.phone, '00123');
  for (const key of ['contactPersonName', 'contactPersonEmail', 'contactPersonPhone']) assert.throws(() => partySaveInput('vendor', { ...vendor(), [key]: '' }));
  assert.deepEqual(partySaveInput('customer', command()).contact, { name: null, email: null, phone: null });
  assert.throws(() => partySaveInput('customer', { ...command(), contactPersonName: 'Only name' }));
  assert.throws(() => partySaveInput('customer', { ...command(), contactPersonEmail: 'contact@example.invalid' }));
  assert.equal(partySaveInput('customer', { ...command(), contactPersonName: 'Contact', contactPersonPhone: '0000' }).contact.phone, '0000');
  assert.throws(() => partySaveInput('customer', { ...command(), contactPersonName: 'Contact', contactPersonEmail: 'bad-address' }));
});

test('Customer address inputs preserve freeform and structured representations without inventing a location', () => {
  const freeform = customerAddressInput(address());
  assert.equal(freeform.freeformAddress, 'Delivery\nReceiving bay'); assert.equal(freeform.city, null); assert.equal(freeform.countryCode, null);
  const structured = customerAddressInput({ id: randomUUID(), addressType: 'billing', line1: ' First line ', city: ' City ', countryCode: 'in' });
  assert.equal(structured.freeformAddress, null); assert.equal(structured.city, 'City'); assert.equal(structured.countryCode, 'IN'); assert.equal(structured.isDefault, false);
  for (const change of [{ city: 'Mixed' }, { freeformAddress: '' }, { addressType: 'invalid' }, { isDefault: null }, { id: 'bad' }]) assert.throws(() => customerAddressInput(address(change)));
  for (const change of [{ countryCode: '1N' }, { city: '' }, { line1: '' }]) assert.throws(() => customerAddressInput({ ...structured, ...change }));
});

test('complete relation lists require unique IDs, one primary contact and one default per address type', () => {
  const first = address(); const second = address({ addressType: 'billing' });
  const contact = { id: randomUUID(), name: 'Contact', phone: '0001', isPrimary: true };
  const input = Object.freeze({ ...command(), addresses: Object.freeze([Object.freeze(first), Object.freeze(second)]), contacts: Object.freeze([Object.freeze(contact)]) });
  const result = partySaveInput('customer', input); assert.equal(result.addresses.length, 2); assert.equal(result.contacts[0].phone, '0001');
  assert.equal(result.flatContactProvided, false); assert.notEqual(result.addresses[0], first);
  for (const addresses of [[first, first], [first, address()], new Array(1), null, Array.from({ length: 101 }, () => address())]) assert.throws(() => partySaveInput('customer', { ...command(), addresses }));
  for (const contacts of [[contact, contact], [contact, { ...contact, id: randomUUID() }], new Array(1), null]) assert.throws(() => partySaveInput('customer', { ...command(), contacts }));
  assert.throws(() => partySaveInput('customer', { ...command(), addresses: [], shipToAddress: '' }), { code: 'ambiguous_party_relations' });
  assert.throws(() => partySaveInput('customer', { ...command(), contacts: [], contactPersonName: '' }), { code: 'ambiguous_party_relations' });
  assert.throws(() => partyContactInput('vendor', contact));
  assert.throws(() => partySaveInput('vendor', { ...command(), contacts: [] }));
  assert.throws(() => partyContactInput('vendor', { ...contact, email: 'vendor@example.invalid', designation: 'Unsupported' }));
});

test('party capture inputs retain omission, explicit empty and typed field values separately', () => {
  assert.equal(partySaveInput('customer', command()).customFieldsProvided, false);
  const empty = partySaveInput('customer', { ...command(), customFields: [] }); assert.equal(empty.customFieldsProvided, true); assert.deepEqual(empty.customFields, []);
  const fields = [{ fieldId: randomUUID(), fieldRevision: 1, value: 0 }, { fieldId: randomUUID(), fieldRevision: 2, value: false }];
  assert.deepEqual(partySaveInput('customer', { ...command(), customFields: fields }).customFields, fields);
  assert.throws(() => partySaveInput('customer', { ...command(), customFields: null }));
  assert.throws(() => partySaveInput('customer', { ...command(), customFieldTimeZone: 'UTC' }), { code: 'invalid_custom_field_timezone' });
  assert.equal(partySaveInput('customer', { ...command(), customFields: fields, customFieldTimeZone: 'UTC' }).customFieldTimeZone, 'UTC');
});
