import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listReportDocuments, saveReportDocument } from '@/report-assets/documents.js';

export const GET = endpoint(async (request) => {
  const search = new URL(request.url).searchParams;
  return json(await authenticated(request, (client, identity) => listReportDocuments(client, identity, {
    type: search.get('type'), query: search.get('query') ?? '', page: Number(search.get('page') ?? 1), pageSize: Number(search.get('pageSize') ?? 10),
  }), { readOnly: true }));
});

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 4_100_000 });
  const result = await authenticated(request, (client, identity) => saveReportDocument(client, identity, input));
  return json(result, result.replayed ? 200 : 201);
});
