import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadOrganization, updateOrganization } from '@/administration/organizations.js';

export const GET = endpoint(async (request, context) => {
  const { organizationId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadOrganization(client, identity, organizationId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { organizationId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateOrganization(client, identity, organizationId, input)));
});
