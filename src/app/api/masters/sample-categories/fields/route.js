import { authenticated, endpoint, json } from '@/auth/http.js';
import { sampleCategoryFieldOptions } from '@/masters/sample-categories.js';

export const GET = endpoint(async request => {
  const search = request.nextUrl.searchParams.get('search') || '';
  return json(await authenticated(request, (client, identity) => sampleCategoryFieldOptions(client, identity, { search }), { readOnly: true }));
});
