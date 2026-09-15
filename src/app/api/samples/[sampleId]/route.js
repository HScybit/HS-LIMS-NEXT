import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadSample } from '@/samples/load.js';
import { updateSample } from '@/samples/update.js';

export const GET = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadSample(client, identity, sampleId), { permission: 'samples.read', readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  // Match registration's transport bound for at most 100 lines / 5,000 tests.
  const input = await readInput(request, { maxBytes: 8_388_608 });
  return json(await authenticated(request, (client, identity) => updateSample(client, identity, sampleId, input), { permission: 'samples.manage' }));
});
