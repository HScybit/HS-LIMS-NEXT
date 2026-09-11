import { endpoint, json, readInput, setSessionCookies } from '@/auth/http.js';
import { signIn } from '@/auth/service.js';

export const POST = endpoint(async (request) => {
  const session = await signIn(await readInput(request));
  const response = json({ ok: true });
  setSessionCookies(response, session);
  return response;
});
