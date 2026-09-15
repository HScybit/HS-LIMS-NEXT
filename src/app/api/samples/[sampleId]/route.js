import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadSample } from '@/samples/load.js';
import { updateSampleHeader } from '@/samples/update.js';

export const GET = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadSample(client, identity, sampleId), { permission: 'samples.read', readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  // Header text fields can exceed the default authentication-sized body bound.
  const input = await readInput(request, { maxBytes: 131_072 });
  return json(await authenticated(request, (client, identity) => updateSampleHeader(client, identity, sampleId, input), { permission: 'samples.manage' }));
});
