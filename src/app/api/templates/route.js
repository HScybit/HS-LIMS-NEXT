import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { createTemplate } from '@/templates/authoring.js';
import { listTemplateRows } from '@/templates/listing.js';
import { HttpError } from '@/auth/errors.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listTemplateRows(client, identity, input), { readOnly: true, permission: 'templates.read' }));
});
export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createTemplate(client, identity, input), { permission: 'templates.manage' }), 201);
});
