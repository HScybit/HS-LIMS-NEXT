import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { loadMaterial, retireMaterial } from '@/materials/service.js';
import { listMaterialTransactions } from '@/materials/listing.js';

export const GET = endpoint(async (request, context) => {
  const { materialId } = await context.params; const query = request.nextUrl.searchParams; const revision = query.get('revision');
  return json(await authenticated(request, async (client, identity) => {
    const material = await loadMaterial(client, identity, materialId, revision === null ? {} : { atRevision: Number(revision) });
    const transactions = revision === null ? await listMaterialTransactions(client, identity, materialId,
      { type: query.get('type') ?? 'all', page: Number(query.get('page') ?? 1), pageSize: Number(query.get('pageSize') ?? 10) }) : null;
    return { material, transactions };
  }, { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { materialId } = await context.params; const input = await readInput(request); fieldsOnly(input, ['requestId', 'revision']);
  return json(await authenticated(request, (client, identity) => retireMaterial(client, identity, { ...input, id: materialId }), { permission: 'masters.manage' }));
});
