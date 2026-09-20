import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { loadUserFieldUserOptions } from '@/users/custom-fields.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams;
  if (query.size > 1 || [...query.keys()].some(key => key !== 'search')) {
    throw new HttpError(400, 'invalid_user_field_query', 'Use only one optional search query.');
  }
  return json(await authenticated(request, (client, identity) =>
    loadUserFieldUserOptions(client, identity, { search: query.get('search') ?? '' }), { readOnly: true }));
});
