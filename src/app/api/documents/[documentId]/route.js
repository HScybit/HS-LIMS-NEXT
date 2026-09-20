import { authenticated, endpoint, json } from '@/auth/http.js';
import { getDocument } from '@/documents/service.js';

export const GET = endpoint(async (request, context) => {
  const { documentId } = await context.params;
  return json(await authenticated(request, (client, identity) => getDocument(client, identity, documentId), { readOnly: true }));
});
