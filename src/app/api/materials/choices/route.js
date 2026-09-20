import { authenticated, endpoint, json } from '@/auth/http.js';
import { materialChoices } from '@/materials/listing.js';

export const GET = endpoint(async request => {
  const query = request.nextUrl.searchParams;
  return json(await authenticated(request, (client, identity) => materialChoices(client, identity, {
    kind: query.get('kind'), page: Number(query.get('page') ?? 1), search: query.get('search') ?? '', selectedId: query.get('selectedId'), materialId: query.get('materialId'),
  }), { readOnly: true }));
});
