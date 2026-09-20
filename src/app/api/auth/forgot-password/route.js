import { endpoint, json, readInput } from '@/auth/http.js';
import { requestPasswordReset } from '@/auth/service.js';

export const POST = endpoint(async (request) => {
  await requestPasswordReset(await readInput(request));
  return json({ ok: true });
});
