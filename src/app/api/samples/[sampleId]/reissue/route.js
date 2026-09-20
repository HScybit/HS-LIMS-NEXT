import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { reissueSampleReports } from '@/reports/service.js';

export const POST = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  const input = await readInput(request, { maxBytes: 8192 });
  return json(await authenticated(request, (client, identity) => reissueSampleReports(client, identity, sampleId, input)), 201);
});
