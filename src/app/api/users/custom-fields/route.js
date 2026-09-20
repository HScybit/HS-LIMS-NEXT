import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { userCustomFields } from '@/masters/custom-fields.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams;
  if (query.size > 1 || [...query.keys()].some(key => key !== 'view') || ![null, 'list'].includes(query.get('view'))) {
    throw new HttpError(400, 'invalid_user_field_query', 'Use view=list for listing fields or omit it for form fields.');
  }
  return json(await authenticated(request, async (client, identity) =>
    ({ fields: await userCustomFields(client, identity, { forListing: query.get('view') === 'list' }) }), { readOnly: true }));
});
