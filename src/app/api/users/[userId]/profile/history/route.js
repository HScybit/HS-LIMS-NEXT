import { authenticated, endpoint, json } from '@/auth/http.js';
import { listUserProfileHistory } from '@/users/profiles.js';
import { HttpError } from '@/auth/errors.js';

export const GET = endpoint(async (request, context) => {
  const { userId } = await context.params; let input;
  try { const raw = request.nextUrl.searchParams.get('query') ?? '{}'; if (raw.length > 16_384) throw new Error(); input = JSON.parse(raw); }
  catch { throw new HttpError(400, 'invalid_user_history_query', 'User history query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listUserProfileHistory(client, identity, userId, input), { readOnly: true }));
});
