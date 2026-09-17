import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { generateCustomerCustomFields } from '@/masters/customer-custom-field-generation.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => generateCustomerCustomFields(client, identity, input), { permission: 'masters.manage', readOnly: true }));
});
