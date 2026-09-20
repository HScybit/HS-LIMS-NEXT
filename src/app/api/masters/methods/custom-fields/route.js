import { authenticated, endpoint, json } from '@/auth/http.js';
import { methodCustomFields } from '@/masters/custom-fields.js';

export const GET = endpoint(async (request) => json(await authenticated(request, async (client, identity) =>
  ({ organizationId: identity.organization_id, fields: await methodCustomFields(client, identity, { forListing: request.nextUrl.searchParams.get('view') === 'list' }) }), { readOnly: true })));
