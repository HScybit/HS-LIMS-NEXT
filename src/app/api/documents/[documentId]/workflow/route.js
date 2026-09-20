import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadDocumentWorkflow } from '@/documents/service.js';

export const GET = endpoint(async (request, context) => {
  const { documentId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadDocumentWorkflow(client, identity, documentId), { readOnly: true }));
});
