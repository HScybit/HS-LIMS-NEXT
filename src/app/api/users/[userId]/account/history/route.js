import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadUserAccountHistory } from '@/users/accounts.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = {};
  for (const key of ['limit', 'beforeRevision']) {
    if (request.nextUrl.searchParams.has(key)) input[key] = Number(request.nextUrl.searchParams.get(key));
  }
  return json(await authenticated(request, (client, identity) => loadUserAccountHistory(client, identity, userId, input), { readOnly: true }));
});
