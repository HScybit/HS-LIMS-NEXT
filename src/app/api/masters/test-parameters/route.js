import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { listTestParameters, saveTestParameter } from '@/masters/test-parameters.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listTestParameters(client, identity, input), { readOnly: true }));
});

export const POST = endpoint(async (request) => {
  // A bounded 1 MiB text grid can expand when escaped in HTTP JSON.
  const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => saveTestParameter(client, identity, input), { permission: 'masters.manage' }));
});
