import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { workflowReferenceOptions } from '@/workflows/references.js';

export const GET = endpoint(async (request, context) => {
  const { kind } = await context.params; const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'Reference lookup is too large.');
  let input;
  try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'Reference lookup is invalid.'); }
  return json(await authenticated(request, (client, identity) => workflowReferenceOptions(client, identity, kind, input), { readOnly: true }));
});

// Large existing role selections exceed practical URL/header limits. The same
// read-only lookup accepts a bounded body, with normal origin and CSRF checks.
export const POST = endpoint(async (request, context) => {
  const { kind } = await context.params; const input = await readInput(request, { maxBytes: 64 * 1024 });
  return json(await authenticated(request, (client, identity) => workflowReferenceOptions(client, identity, kind, input), { readOnly: true }));
});
