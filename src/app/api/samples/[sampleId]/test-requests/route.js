import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { generateTestRequests } from '@/test-requests/generate.js';
import { sampleTestRequests } from '@/test-requests/listing.js';

export const GET = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  return json(await authenticated(request, (client, identity) => sampleTestRequests(client, identity, sampleId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  const input = await readInput(request, { maxBytes: 32_768 });
  return json(await authenticated(request, (client, identity) => generateTestRequests(client, identity, sampleId, input)), 201);
});
