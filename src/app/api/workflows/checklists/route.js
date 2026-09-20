import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { workflowChecklistOptions } from '@/workflows/checklists.js';

export const GET = endpoint(async (request) => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'Checklist lookup is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'Checklist lookup is invalid.'); }
  return json(await authenticated(request, (client, identity) => workflowChecklistOptions(client, identity, input), { readOnly: true }));
});
