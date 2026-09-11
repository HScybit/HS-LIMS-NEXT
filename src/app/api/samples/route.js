import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { registerSample } from '@/samples/register.js';
import { listSamples } from '@/samples/listing.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams;
  const input = { page: Number(query.get('page') ?? 1), pageSize: Number(query.get('pageSize') ?? 10), search: query.get('search') ?? '', sampleType: query.get('sampleType') ?? '' };
  return json(await authenticated(request, (client, identity) => listSamples(client, identity, input), { permission: 'samples.read', readOnly: true }));
});

export const POST = endpoint(async (request) => {
  // Domain bounds still limit 100 products / 5,000 tests. Keep authentication
  // requests at their existing small bound; only registration needs this size.
  const input = await readInput(request, { maxBytes: 8_388_608 });
  return json(await authenticated(request, (client, identity) => registerSample(client, identity, input), { permission: 'samples.create' }), 201);
});
