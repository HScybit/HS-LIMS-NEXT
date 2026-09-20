import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { disableMfa, loadMfaStatus } from '@/auth/mfa.js';

export const GET = endpoint(async (request) => json(await authenticated(request,
  (client) => loadMfaStatus(client), { readOnly: true, accountAction: true })));

export const DELETE = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client) => disableMfa(client, input), { accountAction: true }));
});
