import { authenticated, endpoint, json } from '@/auth/http.js';
import { customerCustomFields } from '@/masters/custom-fields.js';

export const GET = endpoint(async (request) => json(await authenticated(request, async (client, identity) =>
  ({ organizationId: identity.organization_id, fields: await customerCustomFields(client, identity, { forListing: request.nextUrl.searchParams.get('view') === 'list' }) }), { readOnly: true })));
