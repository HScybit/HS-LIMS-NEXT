import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { loadUserFieldLookupOptions } from '@/users/custom-fields.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams;
  if (query.size > 3 || query.getAll('sourceId').length !== 1 || query.getAll('revision').length > 1 || query.getAll('knownOrganizationId').length > 1
    || [...query.keys()].some(key => !['sourceId', 'revision', 'knownOrganizationId'].includes(key))
    || query.has('revision') && !/^[1-9][0-9]{0,9}$/.test(query.get('revision'))) {
    throw new HttpError(400, 'invalid_user_field_query', 'Provide one lookup source and an optional known revision and organization.');
  }
  return json(await authenticated(request, (client, identity) => loadUserFieldLookupOptions(client, identity,
    { sourceId: query.get('sourceId'), ...(query.has('revision') ? { revision: Number(query.get('revision')) } : {}),
      ...(query.has('knownOrganizationId') ? { knownOrganizationId: query.get('knownOrganizationId') } : {}) }), { readOnly: true }));
});
