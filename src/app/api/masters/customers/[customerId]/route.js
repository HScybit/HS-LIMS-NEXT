import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadCustomer, retireCustomer } from '@/masters/customers.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { customerId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadCustomer(client, identity, customerId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { customerId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireCustomer(client, identity, { ...input, id: customerId }), { permission: 'masters.manage' }));
});
