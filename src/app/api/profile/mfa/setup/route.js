import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { cancelMfaSetup, startMfaSetup } from '@/auth/mfa.js';

export const POST = endpoint(async (request) => {
  await readInput(request);
  return json(await authenticated(request, (client, identity) => startMfaSetup(client, identity), { accountAction: true }));
});

export const DELETE = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client) => cancelMfaSetup(client, input), { accountAction: true }));
});
