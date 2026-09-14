import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadUserStatus, updateUserStatus } from '@/users/status.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadUserStatus(client, identity, userId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateUserStatus(client, identity, userId, input), { permission: 'users.manage' }));
});
