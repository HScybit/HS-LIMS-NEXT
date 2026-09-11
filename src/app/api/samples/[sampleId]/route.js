import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadSample } from '@/samples/load.js';

export const GET = endpoint(async (request, context) => {
  const { sampleId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadSample(client, identity, sampleId), { permission: 'samples.read', readOnly: true }));
});
