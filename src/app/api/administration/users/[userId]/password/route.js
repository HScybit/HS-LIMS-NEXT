import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { resetPlatformUserPassword } from '@/administration/platform-users.js';

// Returns a one-time password that is never retrievable again.
export const POST = endpoint(async (request, context) => {
  const { userId } = await context.params;
  const input = await readInput(request, { maxBytes: 4096 });
  return json(await authenticated(request, (client, identity) => resetPlatformUserPassword(client, identity, userId, input)), 201);
});
