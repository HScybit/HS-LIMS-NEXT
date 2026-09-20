import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listOrganizationSeedRuns, runOrganizationSeed } from '@/administration/organization-seed.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { organizationId } = await context.params;
  return json(await authenticated(request, (client, identity) => listOrganizationSeedRuns(client, identity, organizationId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { organizationId } = await context.params;
  const input = await readInput(request, { maxBytes: 4096 });
  fieldsOnly(input, ['confirmation', 'industries', 'runId']);
  return json(await authenticated(request, (client, identity) => runOrganizationSeed(client, identity, organizationId, input)), 201);
});
