import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { allocateTestRequest } from '@/test-requests/allocate.js';

export const POST = endpoint(async (request, context) => {
  const { requestId } = await context.params;
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => allocateTestRequest(client, identity, requestId, input), { permission: 'test_requests.allocate' }));
});
