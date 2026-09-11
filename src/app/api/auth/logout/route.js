import { authenticated, clearSessionCookies, endpoint, json } from '@/auth/http.js';

export const POST = endpoint(async (request) => {
  await authenticated(request, (client) => client.query('SELECT auth_revoke_session()'), { accountAction: true });
  const response = json({ ok: true });
  clearSessionCookies(response);
  return response;
});
