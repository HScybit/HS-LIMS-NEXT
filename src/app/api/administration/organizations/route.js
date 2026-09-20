import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { signIn } from '@/auth/service.js';
import { listOrganizations, createOrganization } from '@/administration/organizations.js';
import { runDemoSeedProvisioning } from '@/seed/run-demo-seed.js';

export const GET = endpoint(async (request) => {
  const input = { search: request.nextUrl.searchParams.get('search') ?? '',
    status: request.nextUrl.searchParams.get('status') ?? 'all',
    page: Number(request.nextUrl.searchParams.get('page') ?? 1), pageSize: Number(request.nextUrl.searchParams.get('pageSize') ?? 20) };
  return json(await authenticated(request, (client, identity) => listOrganizations(client, identity, input), { readOnly: true }));
});

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 8192 });
  if (typeof input.seedDemoData !== 'undefined' && typeof input.seedDemoData !== 'boolean') throw new HttpError(400, 'invalid_input', 'seedDemoData must be true or false.');
  const result = await authenticated(request, (client, identity) => createOrganization(client, identity, input));
  const response = { organizationId: result.organizationId, admin: { username: result.admin.username, temporaryPassword: result.admin.temporaryPassword } };
  if (result.seedDemoData) {
    try {
      const session = await signIn({ identifier: result.admin.username, password: result.admin.temporaryPassword });
      await runDemoSeedProvisioning(session);
      response.seeded = true;
    } catch (error) {
      response.seeded = false; response.seedError = error.message;
    }
  }
  return json(response, 201);
});
