import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { listUsers } from '@/users/directory.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listUsers(client, identity, input), { readOnly: true }));
});
