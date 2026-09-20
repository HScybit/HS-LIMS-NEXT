import { authenticated, endpoint, json } from '@/auth/http.js';
import { organizationSeedProgress } from '@/administration/organization-seed.js';

// Followed while a seeding run is in flight. Each step commits in its own
// transaction as it completes, so this reports real progress rather than an
// estimate.
export const GET = endpoint(async (request, context) => {
  const { organizationId, runId } = await context.params;
  return json(await authenticated(request, (client, identity) => organizationSeedProgress(client, identity, organizationId, runId), { readOnly: true }));
});
