import { authenticated, endpoint, json } from '@/auth/http.js';
import { instrumentFieldUserOptions } from '@/instruments/custom-field-options.js';
import { HttpError } from '@/auth/errors.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams;
  if (query.size > 1 || [...query.keys()].some(key => key !== 'search')) throw new HttpError(400, 'invalid_custom_field_user_query', 'Use only one optional search query.');
  return json(await authenticated(request, (client, identity) => instrumentFieldUserOptions(client, identity, { search: query.get('search') ?? '' }), { readOnly: true }));
});
