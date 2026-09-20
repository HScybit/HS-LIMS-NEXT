import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listDocuments, createDocument } from '@/documents/service.js';

export const GET = endpoint(async (request) => {
  const documentCategoryId = request.nextUrl.searchParams.get('documentCategoryId') ?? undefined;
  return json(await authenticated(request, (client, identity) => listDocuments(client, identity, { documentCategoryId }), { readOnly: true }));
});

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createDocument(client, identity, input)), 201);
});
