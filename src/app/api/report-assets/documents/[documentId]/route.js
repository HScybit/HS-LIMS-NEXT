import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadReportDocument, deleteReportDocument } from '@/report-assets/documents.js';

export const GET = endpoint(async (request, context) => {
  const { documentId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadReportDocument(client, identity, documentId), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { documentId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => deleteReportDocument(client, identity, documentId, input)));
});
