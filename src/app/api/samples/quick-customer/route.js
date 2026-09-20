import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { quickCreateCustomer } from '@/samples/customer.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 65_536 });
  return json(await authenticated(request, (client, identity) => quickCreateCustomer(client, identity, input), { permission: 'samples.create' }), 201);
});
