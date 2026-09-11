import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { updateProfile } from '@/auth/service.js';

export const PATCH = endpoint(async (request) => {
  const input = await readInput(request);
  await authenticated(request, (client) => updateProfile(client, input), { accountAction: true });
  return json({ ok: true });
});
