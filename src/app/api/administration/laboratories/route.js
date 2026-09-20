import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { listLaboratories, saveLaboratory } from '@/masters/laboratories.js';

export const GET = endpoint(async request => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listLaboratories(client, identity, input), { readOnly: true }));
});

export const POST = endpoint(async request => {
  const input = await readInput(request, { maxBytes: 1_048_576 });
  return json(await authenticated(request, (client, identity) => saveLaboratory(client, identity, input), { permission: 'users.manage' }));
});
