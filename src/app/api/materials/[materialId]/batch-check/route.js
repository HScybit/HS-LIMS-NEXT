import { authenticated, endpoint, json } from '@/auth/http.js';
import { checkIncomingMaterialBatch } from '@/materials/listing.js';

export const GET = endpoint(async (request, context) => {
  const { materialId } = await context.params;
  return json(await authenticated(request, (client, identity) => checkIncomingMaterialBatch(client, identity, materialId, request.nextUrl.searchParams.get('batch') ?? ''), { readOnly: true }));
});
