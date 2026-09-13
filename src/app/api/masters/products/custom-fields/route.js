import { authenticated, endpoint, json } from '@/auth/http.js';
import { productCustomFields } from '@/masters/custom-fields.js';

export const GET = endpoint(async (request) => json(await authenticated(request, async (client, identity) =>
  ({ fields: await productCustomFields(client, identity) }), { readOnly: true })));
