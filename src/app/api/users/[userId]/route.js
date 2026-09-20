import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadUser } from '@/users/directory.js';
import { updateUserForm } from '@/users/forms.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadUser(client, identity, userId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => updateUserForm(client, identity, userId, input), { permission: 'users.manage' }));
});
