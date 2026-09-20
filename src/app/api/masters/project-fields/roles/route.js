import { authenticated, endpoint, json } from '@/auth/http.js';
import { customFieldRoles } from '@/masters/custom-fields.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  customFieldRoles(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
