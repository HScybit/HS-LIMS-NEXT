import { authenticated, endpoint, json } from '@/auth/http.js';
import { instrumentFieldLookupOptions } from '@/instruments/custom-field-options.js';
import { masterFieldLookupQuery } from '@/masters/custom-field-lookup-query.js';

export const GET = endpoint(async (request) => {
  const query = masterFieldLookupQuery(request.nextUrl.searchParams);
  return json(await authenticated(request, (client, identity) => instrumentFieldLookupOptions(client, identity, query), { readOnly: true }));
});
