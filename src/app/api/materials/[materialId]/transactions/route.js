import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { createMaterialTransaction } from '@/materials/service.js';

export const POST = endpoint(async (request, context) => {
  const { materialId } = await context.params; const input = await readInput(request, { maxBytes: 16 * 1024 });
  fieldsOnly(input, ['id', 'requestId', 'type', 'quantity', 'cost', 'supplier', 'batchSerialNumber', 'expiryDate']);
  return json(await authenticated(request, (client, identity) => createMaterialTransaction(client, identity, { ...input, materialId }), { permission: 'masters.manage' }));
});
