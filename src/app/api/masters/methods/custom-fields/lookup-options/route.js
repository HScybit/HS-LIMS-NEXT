import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadMasterFieldLookupOptions } from '@/custom-fields/lookup-sources.js';
import { masterFieldLookupQuery } from '@/masters/custom-field-lookup-query.js';

export const GET = endpoint(async (request) => {
  const query = masterFieldLookupQuery(request.nextUrl.searchParams);
  return json(await authenticated(request, (client, identity) => loadMasterFieldLookupOptions('method', client, identity, query), { readOnly: true }));
});
