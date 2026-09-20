import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { listMaterials } from '@/materials/listing.js';
import { saveMaterial } from '@/materials/service.js';

export const GET = endpoint(async request => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listMaterials(client, identity, input), { readOnly: true }));
});

export const POST = endpoint(async request => {
  const input = await readInput(request, { maxBytes: 128 * 1024 });
  return json(await authenticated(request, (client, identity) => saveMaterial(client, identity, input), { permission: 'masters.manage' }));
});
