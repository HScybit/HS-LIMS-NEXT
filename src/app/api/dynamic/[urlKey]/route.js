import { endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { transaction } from '@/db/pool.js';
import { invokeDynamicApi } from '@/dynamic-apis/service.js';

// Bearer-token authenticated, not session-authenticated — third-party callers
// have no session cookie/CSRF token, so this deliberately bypasses
// authenticated()/assertSameOrigin() (both are for browser-origin, cookie-based
// requests) and reads the token from the Authorization header instead.
async function readRequestInput(request, httpMethod) {
  if (!['POST', 'PUT', 'PATCH'].includes(httpMethod)) return Object.fromEntries(new URL(request.url).searchParams);
  const body = await request.text();
  if (!body) return {};
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new HttpError(400, 'invalid_input', 'Request body must be valid JSON.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'invalid_input', 'Request body must be a JSON object.');
  return parsed;
}

function dispatch(httpMethod) {
  return endpoint(async (request, context) => {
    const { urlKey } = await context.params;
    const header = request.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const requestInput = await readRequestInput(request, httpMethod);
    const result = await transaction((client) => invokeDynamicApi(client, token, httpMethod, urlKey, requestInput));
    return json(result);
  });
}

export const GET = dispatch('GET');
export const POST = dispatch('POST');
export const PUT = dispatch('PUT');
export const PATCH = dispatch('PATCH');
export const DELETE = dispatch('DELETE');
