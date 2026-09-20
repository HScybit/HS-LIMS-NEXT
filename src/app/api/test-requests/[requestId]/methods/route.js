import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { addTestRequestMethod } from '@/test-requests/methods.js';

export const POST = endpoint(async (request, context) => {
  const { requestId } = await context.params;
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => addTestRequestMethod(client, identity, requestId, input), { permission: 'datasheets.execute' }), 201);
});
