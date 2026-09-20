import { authenticated, endpoint, json } from '@/auth/http.js';
import { sampleCategoryUserOptions } from '@/masters/sample-categories.js';

export const GET = endpoint(async request => {
  const search = request.nextUrl.searchParams.get('search') || '';
  return json(await authenticated(request, (client, identity) => sampleCategoryUserOptions(client, identity, { search }), { readOnly: true }));
});
