import { authenticated, endpoint, json } from '@/auth/http.js';
import { sampleCategoryTemplateOptions } from '@/masters/sample-categories.js';

export const GET = endpoint(async request => {
  const search = request.nextUrl.searchParams.get('search') || '';
  const purpose = request.nextUrl.searchParams.get('purpose') || '';
  return json(await authenticated(request, (client, identity) => sampleCategoryTemplateOptions(client, identity, { search, purpose }), { readOnly: true }));
});
