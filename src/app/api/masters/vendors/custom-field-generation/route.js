import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { generateVendorCustomFields } from '@/masters/vendor-custom-field-generation.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => generateVendorCustomFields(client, identity, input), { permission: 'masters.manage', readOnly: true }));
});
