import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { loadUserCustomFieldHistory } from '@/users/custom-fields.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params; const query = request.nextUrl.searchParams; const input = {};
  for (const [key, value] of query) {
    if (!['limit', 'beforeRevision'].includes(key) || Object.hasOwn(input, key) || !/^[1-9]\d*$/.test(value)) throw new HttpError(400, 'invalid_input', 'History query is invalid.');
    input[key] = Number(value);
  }
  return json(await authenticated(request, (client, identity) => loadUserCustomFieldHistory(client, identity, userId, input), { readOnly: true }));
});
