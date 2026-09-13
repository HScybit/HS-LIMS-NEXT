import { authenticated, endpoint, json } from '@/auth/http.js';
import { masterCustomFieldUsers } from '@/masters/custom-fields.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  masterCustomFieldUsers(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
