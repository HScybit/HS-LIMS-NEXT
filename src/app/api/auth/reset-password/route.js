import { clearSessionCookies, endpoint, json, readInput } from '@/auth/http.js';
import { completePasswordReset } from '@/auth/service.js';

export const POST = endpoint(async (request) => {
  await completePasswordReset(await readInput(request));
  const response = json({ ok: true });
  clearSessionCookies(response);
  return response;
});
