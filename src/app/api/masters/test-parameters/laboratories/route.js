import { authenticated, endpoint, json } from '@/auth/http.js';
import { parameterLaboratories } from '@/masters/test-parameters.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  parameterLaboratories(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
