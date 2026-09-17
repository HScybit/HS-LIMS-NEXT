import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { processMasterBulk } from '@/masters/bulk-service.js';

export const POST = endpoint(async (request, context) => {
  const { batchId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => processMasterBulk(client, identity, batchId, input)));
});
