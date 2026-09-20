import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { changePassword } from '@/auth/service.js';

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  await authenticated(request, (client) => changePassword(client, input), { accountAction: true });
  return json({ ok: true });
});
