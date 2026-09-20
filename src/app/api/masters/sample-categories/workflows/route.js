import { authenticated, endpoint, json } from '@/auth/http.js';
import { sampleCategoryWorkflows } from '@/masters/sample-categories.js';

export const GET = endpoint(async request => {
  const search = request.nextUrl.searchParams.get('search') || '';
  return json(await authenticated(request, (client, identity) => sampleCategoryWorkflows(client, identity, { search }), { readOnly: true }));
});
