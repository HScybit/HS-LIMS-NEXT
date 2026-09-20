import { authenticated, endpoint, json } from '@/auth/http.js';
import { productTemplates } from '@/masters/products.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  productTemplates(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
