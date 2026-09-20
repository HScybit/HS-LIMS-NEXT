import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { loadUserCustomFields, saveUserCustomFields } from '@/users/custom-fields.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params; const query = request.nextUrl.searchParams;
  if (query.size > 1 || [...query.keys()].some(key => key !== 'atRevision') || (query.has('atRevision') && !/^[1-9]\d*$/.test(query.get('atRevision')))) {
    throw new HttpError(400, 'invalid_input', 'Use a positive atRevision or omit it for current values.');
  }
  const input = query.has('atRevision') ? { atRevision: Number(query.get('atRevision')) } : {};
  return json(await authenticated(request, (client, identity) => loadUserCustomFields(client, identity, userId, input), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { userId } = await context.params; const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => saveUserCustomFields(client, identity, userId, input), { permission: 'users.manage' }));
});
