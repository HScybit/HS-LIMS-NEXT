export function customerAddressText(address) {
  return address.freeformAddress ?? [address.attentionTo, address.line1, address.line2, address.city, address.state, address.postalCode, address.countryCode].filter(Boolean).join(', ');
}
