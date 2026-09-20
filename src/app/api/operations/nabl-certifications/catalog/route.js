import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { nablCatalog } from '@/compliance/nabl.js';

export const POST = endpoint(async request => {
  const input = await readInput(request, { maxBytes: 1_048_576 });
  return json(await authenticated(request, (client, identity) => nablCatalog(client, identity, input), { readOnly: true }));
});
