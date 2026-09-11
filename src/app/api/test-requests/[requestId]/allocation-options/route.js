import { authenticated, endpoint, json } from '@/auth/http.js';
import { allocationOptions } from '@/test-requests/listing.js';

export const GET = endpoint(async (request, context) => {
  const { requestId } = await context.params;
  return json(await authenticated(request, (client, identity) => allocationOptions(client, identity, requestId), { permission: 'test_requests.allocate', readOnly: true }));
});
