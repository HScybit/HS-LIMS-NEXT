import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { saveInstrumentCore } from '@/instruments/core.js';
import { listInstruments } from '@/instruments/list.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listInstruments(client, identity, input), { readOnly: true }));
});

export const POST = endpoint(async (request) => {
  const input = await readInput(request, { maxBytes: 8 * 1_048_576 });
  return json(await authenticated(request, (client, identity) => saveInstrumentCore(client, identity, input), { permission: 'instruments.manage' }));
});
