import { createHash } from 'node:crypto';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

// Hash the validated, supplied intent. Omitted fields can change in a later
// revision without changing the receipt for an earlier partial save. The hash
// is only a retry tag; the actual saved state has typed, immutable history.
export function partyRequestFingerprint(kind, raw, input) {
  if (!['customer', 'vendor'].includes(kind)) throw new TypeError('Unsupported party master.');
  const intent = Object.fromEntries(Object.keys(raw).sort().map(key => {
    if (key === 'status') return [key, input.active];
    if (['shipToAddress', 'billToAddress'].includes(key)) return [key, input.addressUpdates[key]];
    const contactKey = { contactPersonName: 'name', contactPersonEmail: 'email', contactPersonPhone: 'phone' }[key];
    if (contactKey) return [key, input.contact[contactKey]];
    if (!Object.hasOwn(input, key)) throw new TypeError('Fingerprint requires validated party input.');
    return [key, input[key]];
  }));
  return createHash('sha256').update(JSON.stringify([kind, ordered(intent)])).digest('hex');
}
