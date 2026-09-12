import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { deleteTestRequestMethod } from '@/test-requests/methods.js';

export const DELETE = endpoint(async (request, context) => {
  const { requestId, datasheetId } = await context.params;
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => deleteTestRequestMethod(client, identity, requestId, datasheetId, input), { permission: 'datasheets.execute' }));
});
