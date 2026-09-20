import { randomUUID } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { customerAddressText } from './customer-address.js';

const defaultAddress = (addresses, type) => addresses.find(address => address.addressType === type && address.isDefault)
  ?? addresses.find(address => address.addressType === type);
const primaryContact = contacts => contacts.find(contact => contact.isPrimary) ?? contacts[0];

export function partyContactFields(contacts) {
  const contact = primaryContact(contacts);
  return { contactPersonName: contact?.name ?? null, contactPersonEmail: contact?.email ?? null, contactPersonPhone: contact?.phone ?? null };
}

export function customerAddressFields(addresses) {
  const text = type => { const address = defaultAddress(addresses, type); return address ? customerAddressText(address) : null; };
  return { shipToAddress: text('shipping'), billToAddress: text('billing') };
}

// Form fields edit the selected default/primary relation. Complete lists are an
// explicit replacement. The native command still verifies every child owner.
export function resolvePartyRelations(kind, input, existing = {}, { newId = randomUUID } = {}) {
  if (!['customer', 'vendor'].includes(kind)) throw new TypeError('Unsupported party master.');
  let contacts = (input.contactsProvided ? input.contacts : existing.contacts ?? []).map(contact => ({ ...contact }));
  if (input.flatContactProvided) {
    const current = primaryContact(contacts); const values = input.contact;
    if (Object.values(values).every(value => value === null)) contacts = contacts.filter(contact => contact !== current);
    else if (!current || ['name', 'email', 'phone'].some(key => (current[key] ?? null) !== values[key])) {
      const replacement = { ...current, id: current?.id ?? newId(), ...values, isPrimary: true,
        ...(kind === 'customer' ? { designation: current?.designation ?? null } : {}) };
      if (current) contacts[contacts.indexOf(current)] = replacement; else contacts.push(replacement);
    }
  }
  let addresses;
  if (kind === 'customer') {
    addresses = (input.addressesProvided ? input.addresses : existing.addresses ?? []).map(address => ({ ...address }));
    for (const [key, type] of [['shipToAddress', 'shipping'], ['billToAddress', 'billing']]) {
      if (!Object.hasOwn(input.addressUpdates, key)) continue;
      const value = input.addressUpdates[key]; const current = defaultAddress(addresses, type);
      if (value === null) addresses = addresses.filter(address => address !== current);
      else if (!current || customerAddressText(current).trim() !== value) {
        const replacement = { id: current?.id ?? newId(), addressType: type, attentionTo: null, line1: null, line2: null, city: null,
          state: null, postalCode: null, countryCode: null, freeformAddress: value, isDefault: true };
        if (current) addresses[addresses.indexOf(current)] = replacement; else addresses.push(replacement);
      }
    }
  }
  if (contacts.length > 100 || (addresses?.length ?? 0) > 100) throw new HttpError(400, 'party_relation_limit', 'A master supports at most 100 addresses and 100 contacts.');
  return { contacts, ...(kind === 'customer' ? { addresses } : {}) };
}
