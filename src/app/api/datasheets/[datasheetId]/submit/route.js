import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { submitDatasheet } from '@/datasheets/submit.js';

export const POST = endpoint(async (request, context) => {
  const { datasheetId } = await context.params;
  const input = await readInput(request, { maxBytes: 64 * 1024 });
  return json(await authenticated(request, (client, identity) => submitDatasheet(client, identity, datasheetId, input), { permission: 'datasheets.execute' }));
});
