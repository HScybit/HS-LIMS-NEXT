import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadUser } from '@/users/directory.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadUser(client, identity, userId), { readOnly: true }));
});
