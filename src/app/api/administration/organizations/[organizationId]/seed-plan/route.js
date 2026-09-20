import { authenticated, endpoint, json } from '@/auth/http.js';
import { organizationSeedPlan } from '@/administration/organization-seed.js';

export const GET = endpoint(async (request, context) => {
  const { organizationId } = await context.params;
  return json(await authenticated(request, (client, identity) => organizationSeedPlan(client, identity, organizationId), { readOnly: true }));
});
