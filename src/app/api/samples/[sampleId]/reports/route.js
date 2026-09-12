import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { generateReports, listReports } from '@/reports/service.js';

export const GET = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  return json(await authenticated(request, (client, identity) => listReports(client, identity, sampleId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  const input = await readInput(request, { maxBytes: 131_072 });
  return json(await authenticated(request, (client, identity) => generateReports(client, identity, sampleId, input)), 201);
});
