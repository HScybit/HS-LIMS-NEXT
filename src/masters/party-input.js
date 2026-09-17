import { HttpError } from '../auth/errors.js';
import { bool, decimal, fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';

const labels = Object.freeze({ customer: 'Customer', vendor: 'Vendor' });
const contactKeys = ['contactPersonName', 'contactPersonEmail', 'contactPersonPhone'];
const addressKeys = ['shipToAddress', 'billToAddress'];
const customerKeys = ['creditDays', ...addressKeys, 'addresses', 'defaultInvoiceNotes', 'feedbackApplicable',
  'igstPercent', 'sgstPercent', 'cgstPercent', 'discountPercent', 'isKaleenBandhu'];

function partyLabel(kind) {
  if (!Object.hasOwn(labels, kind)) throw new TypeError('Unsupported party master.');
  return labels[kind];
}
function partyText(value, label, maximum, optional = false) {
  if (optional && value == null) return null;
  const result = text(typeof value === 'string' ? value.trim() : value, label, maximum, { optional });
  if (result.includes('\0') || !result.isWellFormed()) throw new HttpError(400, 'invalid_input', `${label} must be valid text without null characters.`);
  return optional && result === '' ? null : result;
}
function email(value, optional = false) {
  const result = partyText(value, 'Contact Person Email', 320, optional);
  if (result !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'invalid_email', 'Enter a valid contact email address.');
  return result;
}

function percentWithinBounds(value) {
  const [, sign, whole, fraction = '', exponent = '0'] = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  const raw = whole + fraction; const digits = raw.replace(/^0+/, '');
  if (!digits) return true;
  if (sign === '-') return false;
  const decimalPosition = whole.length + Number(exponent) - (raw.length - digits.length);
  if (decimalPosition !== 3) return decimalPosition < 3;
  const integerPart = digits.slice(0, 3).padEnd(3, '0');
  return integerPart < '100' || integerPart === '100' && !/[1-9]/.test(digits.slice(3));
}

// Keep decimal text exact until PostgreSQL applies the source's declared scale.
// The native command must normalize it before comparing an earlier save receipt.
function partyDecimal(value, label, percent = false) {
  const result = decimal(typeof value === 'string' ? value.trim() : value, label);
  if (percent && !percentWithinBounds(result)) throw new HttpError(400, 'invalid_input', `${label} must be between 0 and 100.`);
  return result;
}

export function generatedPartyCode(kind, value) {
  const label = partyLabel(kind);
  const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return normalized || label.toUpperCase();
}

export function partyCommandInput(kind, input) {
  const label = partyLabel(kind);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_input', 'Provide a master save request.');
  return { id: uuid(input.id, label).toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646) };
}

function childList(input, label, normalize) {
  if (!Array.isArray(input) || input.length > 100) throw new HttpError(400, 'invalid_party_relations', `Provide at most 100 ${label}.`);
  const ids = new Set();
  return Array.from(input, item => {
    const result = normalize(item);
    if (ids.has(result.id)) throw new HttpError(400, 'invalid_party_relations', `Each ${label} identifier can be used only once.`);
    ids.add(result.id); return result;
  });
}

export function customerAddressInput(input) {
  fieldsOnly(input, ['id', 'addressType', 'attentionTo', 'line1', 'line2', 'city', 'state', 'postalCode', 'countryCode', 'freeformAddress', 'isDefault']);
  const id = uuid(input.id, 'Address').toLowerCase();
  if (!['billing', 'shipping', 'registered', 'other'].includes(input.addressType)) throw new HttpError(400, 'invalid_party_address', 'Select a valid address type.');
  const freeformAddress = partyText(input.freeformAddress, 'Address', 4000, true);
  const structured = Object.fromEntries([['attentionTo', 200], ['line1', 250], ['line2', 250], ['city', 120], ['state', 120], ['postalCode', 30], ['countryCode', 2]]
    .map(([key, maximum]) => [key, partyText(input[key], key, maximum, true)]));
  if (freeformAddress !== null) {
    if (Object.values(structured).some(value => value !== null)) throw new HttpError(400, 'invalid_party_address', 'Provide either a freeform address or its structured fields.');
  } else {
    if (!structured.line1 || !structured.city || !/^[A-Za-z]{2}$/.test(structured.countryCode ?? '')) {
      throw new HttpError(400, 'invalid_party_address', 'A structured address requires line 1, city and a two-letter country code.');
    }
    structured.countryCode = structured.countryCode.toUpperCase();
  }
  return { id, addressType: input.addressType, ...structured, freeformAddress, isDefault: bool(input.isDefault === undefined ? false : input.isDefault, 'Default address') };
}

export function partyContactInput(kind, input) {
  partyLabel(kind); fieldsOnly(input, ['id', 'name', 'email', 'phone', 'isPrimary', ...(kind === 'customer' ? ['designation'] : [])]);
  const result = { id: uuid(input.id, 'Contact').toLowerCase(), name: partyText(input.name, 'Contact Person', 200),
    email: email(input.email, kind === 'customer'), phone: partyText(input.phone, 'Contact Person Phone', 50, kind === 'customer'),
    ...(kind === 'customer' ? { designation: partyText(input.designation, 'Designation', 120, true) } : {}),
    isPrimary: bool(input.isPrimary === undefined ? false : input.isPrimary, 'Primary contact') };
  if (!result.email && !result.phone) throw new HttpError(400, 'invalid_party_contact', 'A contact requires an email address or phone number.');
  return result;
}

export function partySaveInput(kind, input, existing = null) {
  const label = partyLabel(kind);
  fieldsOnly(input, ['id', 'requestId', 'revision', 'code', 'name', 'legalName', 'abbreviation', 'taxIdentifier', 'totalBalance', ...contactKeys, 'contacts', 'status',
    'customFields', 'customFieldTimeZone', ...(kind === 'customer' ? customerKeys : [])]);
  const command = partyCommandInput(kind, input);
  const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : existing?.[key] ?? fallback;
  const name = partyText(value('name'), 'Name', 250); const legalName = partyText(value('legalName'), 'Legal Name', 250);
  const abbreviation = partyText(value('abbreviation'), 'Abbreviation', 64, true);
  let code;
  if (Object.hasOwn(input, 'code')) {
    code = partyText(input.code, 'Code', 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(code)) throw new HttpError(400, 'invalid_party_code', 'Code must start with a letter or number and contain only letters, numbers, dots, slashes, underscores or hyphens.');
  } else code = existing?.code ?? generatedPartyCode(kind, abbreviation || name);
  const status = value('status', existing?.active === false ? 'inactive' : 'active');
  if (!['active', 'inactive'].includes(status)) throw new HttpError(400, 'invalid_party_status', `${label} status must be Active or Inactive.`);
  const addressesProvided = Object.hasOwn(input, 'addresses'); const contactsProvided = Object.hasOwn(input, 'contacts');
  if (addressesProvided && addressKeys.some(key => Object.hasOwn(input, key)) || contactsProvided && contactKeys.some(key => Object.hasOwn(input, key))) {
    throw new HttpError(400, 'ambiguous_party_relations', 'Provide full address/contact lists or their individual form fields, not both.');
  }
  const contacts = contactsProvided ? childList(input.contacts, 'contacts', item => partyContactInput(kind, item)) : undefined;
  if (kind === 'vendor' && contactsProvided && contacts.length === 0) throw new HttpError(400, 'invalid_party_contact', 'A Vendor requires a contact.');
  if (contacts?.filter(contact => contact.isPrimary).length > 1) throw new HttpError(400, 'invalid_party_contact', 'Select only one primary contact.');
  const addresses = addressesProvided ? childList(input.addresses, 'addresses', customerAddressInput) : undefined;
  const defaults = new Set();
  for (const address of addresses ?? []) {
    if (address.isDefault && defaults.has(address.addressType)) throw new HttpError(400, 'invalid_party_address', `Select only one default ${address.addressType} address.`);
    if (address.isDefault) defaults.add(address.addressType);
  }
  const flatContactProvided = !contactsProvided && (!existing || contactKeys.some(key => Object.hasOwn(input, key)));
  const contact = flatContactProvided ? { name: partyText(value('contactPersonName'), 'Contact Person', 200, kind === 'customer'),
    email: email(value('contactPersonEmail'), kind === 'customer'), phone: partyText(value('contactPersonPhone'), 'Contact Person Phone', 50, kind === 'customer') } : null;
  if (contact && Object.values(contact).some(item => item !== null) && (!contact.name || !contact.email && !contact.phone)) {
    throw new HttpError(400, 'invalid_party_contact', 'Provide the contact name and an email address or phone number.');
  }
  const customFieldsProvided = Object.hasOwn(input, 'customFields');
  const customFields = customFieldsProvided ? customFieldValuesInput(input.customFields) : undefined;
  const zone = input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone);
  if (!customFieldsProvided && zone !== null) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
  return { ...command, code, name, legalName, abbreviation, taxIdentifier: partyText(value('taxIdentifier'), 'GST Number', 100, true),
    totalBalance: partyDecimal(value('totalBalance', 0), 'Total Balance'), active: status === 'active',
    contactsProvided, contacts, flatContactProvided, contact, customFieldsProvided, customFields, customFieldTimeZone: zone,
    ...(kind === 'customer' ? { creditDays: integer(value('creditDays', 0), 'Default Credit Period', 0, 3650),
      defaultInvoiceNotes: partyText(value('defaultInvoiceNotes'), 'Notes', 10000, true), feedbackApplicable: bool(value('feedbackApplicable', false), 'Applicable for Feedback'),
      igstPercent: partyDecimal(value('igstPercent', 18), 'IGST', true), sgstPercent: partyDecimal(value('sgstPercent', 0), 'SGST', true),
      cgstPercent: partyDecimal(value('cgstPercent', 0), 'CGST', true), discountPercent: partyDecimal(value('discountPercent', 0), 'Discount', true),
      isKaleenBandhu: bool(value('isKaleenBandhu', false), 'Kaleen Bandhu'), addressesProvided, addresses,
      addressUpdates: Object.fromEntries(addressKeys.filter(key => Object.hasOwn(input, key)).map(key => [key, partyText(input[key], key === 'shipToAddress' ? 'Ship to Address' : 'Bill to Address', 4000, true)])) } : {}),
  };
}
