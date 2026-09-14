import { authenticated, endpoint, json } from '@/auth/http.js';
import { listUserProfileReferences } from '@/users/profiles.js';
import { HttpError } from '@/auth/errors.js';

export const GET = endpoint(async (request) => {
  let input;
  try { const raw = request.nextUrl.searchParams.get('query') ?? '{}'; if (raw.length > 16_384) throw new Error(); input = JSON.parse(raw); }
  catch { throw new HttpError(400, 'invalid_user_reference_query', 'User reference query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listUserProfileReferences(client, identity, input), { readOnly: true }));
});
