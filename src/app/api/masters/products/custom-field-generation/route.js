import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { generateProductCustomFields } from '@/masters/product-custom-field-generation.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 256 * 1024 });
  return json(await authenticated(request, (client, identity) => generateProductCustomFields(client, identity, input), { permission: 'masters.manage', readOnly: true }));
});
