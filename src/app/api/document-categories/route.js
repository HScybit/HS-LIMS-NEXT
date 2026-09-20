import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listDocumentCategories, createDocumentCategory } from '@/documents/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, listDocumentCategories, { readOnly: true })));

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createDocumentCategory(client, identity, input)), 201);
});
