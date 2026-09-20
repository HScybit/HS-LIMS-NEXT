import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { getDocumentCategory, updateDocumentCategory } from '@/documents/service.js';

export const GET = endpoint(async (request, context) => {
  const { categoryId } = await context.params;
  return json(await authenticated(request, (client, identity) => getDocumentCategory(client, identity, categoryId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { categoryId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateDocumentCategory(client, identity, categoryId, input)));
});
