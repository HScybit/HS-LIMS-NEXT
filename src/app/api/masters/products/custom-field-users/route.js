import { authenticated, endpoint, json } from '@/auth/http.js';
import { productCustomFieldUsers } from '@/masters/products.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  productCustomFieldUsers(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
