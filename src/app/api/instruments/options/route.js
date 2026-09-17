import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { instrumentOptions } from '@/instruments/options.js';

export const GET = endpoint(async request => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 24_000) throw new HttpError(413, 'input_too_large', 'Choice query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'Choice query is invalid.'); }
  return json(await authenticated(request, (client, identity) => instrumentOptions(client, identity, input), { readOnly: true }));
});

// Large retained selections use a bounded body instead of exceeding URL limits.
export const POST = endpoint(async request => {
  const input = await readInput(request, { maxBytes: 24_000 });
  return json(await authenticated(request, (client, identity) => instrumentOptions(client, identity, input), { readOnly: true }));
});
