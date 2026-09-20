import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadProduct, retireProduct } from '@/masters/products.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { productId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadProduct(client, identity, productId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { productId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireProduct(client, identity, { ...input, id: productId }), { permission: 'masters.manage' }));
});
