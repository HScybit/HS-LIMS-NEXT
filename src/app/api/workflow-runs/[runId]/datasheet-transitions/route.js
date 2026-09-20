import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { submitDatasheetTransition } from '@/workflows/requests.js';

export const POST = endpoint(async (request, context) => {
  const { runId } = await context.params;
  const input = await readInput(request, { maxBytes: 64 * 1024 });
  return json(await authenticated(request, (client, identity) => submitDatasheetTransition(client, identity, runId, input), { permission: 'datasheets.execute' }));
});
