import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { correctMasterBulkRow, loadMasterBulkPreview } from '@/masters/bulk-store.js';

export const GET = endpoint(async (request, context) => {
  const { batchId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadMasterBulkPreview(client, identity, batchId,
    { page: Number(request.nextUrl.searchParams.get('page') ?? 1), status: request.nextUrl.searchParams.get('status') ?? 'all' }), { readOnly: true }));
});
export const PATCH = endpoint(async (request, context) => {
  const { batchId } = await context.params; const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => correctMasterBulkRow(client, identity, batchId, input), { permission: 'masters.manage' }));
});
