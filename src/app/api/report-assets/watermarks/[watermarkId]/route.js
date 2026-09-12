import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadWatermark, deleteWatermark } from '@/report-assets/watermarks.js';

export const GET = endpoint(async (request, context) => {
  const { watermarkId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadWatermark(client, identity, watermarkId), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { watermarkId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => deleteWatermark(client, identity, watermarkId, input)));
});
