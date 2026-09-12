import { authenticated, endpoint, json } from '@/auth/http.js';
import { productTags } from '@/masters/products.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) =>
  productTags(client, identity, { search: request.nextUrl.searchParams.get('search') ?? '' }), { readOnly: true })));
