import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { reviewMasterBulk } from '@/masters/bulk-service.js';

export const POST = endpoint(async (request, context) => {
  const { batchId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => reviewMasterBulk(client, identity, batchId, input), { permission: 'masters.manage' }));
});
