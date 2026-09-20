import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadUserFieldUserLabels } from '@/users/custom-fields.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 256 * 1024 });
  return json(await authenticated(request, (client, identity) => loadUserFieldUserLabels(client, identity, input), { readOnly: true }));
});
