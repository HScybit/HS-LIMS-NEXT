import { authenticated, endpoint, json } from '@/auth/http.js';
import { methodUsers } from '@/masters/methods.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  methodUsers(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
