import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadUserAccount, updateUserAccount } from '@/users/accounts.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadUserAccount(client, identity, userId), { readOnly: true }));
});
export const PATCH = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateUserAccount(client, identity, userId, input), { permission: 'users.manage' }));
});
