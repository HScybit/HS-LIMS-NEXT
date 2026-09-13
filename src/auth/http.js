import 'server-only';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { HttpError } from './errors.js';
import { withSession, publicIdentity } from './service.js';

export const SESSION_COOKIE = 'sampleify_session';
export const CSRF_COOKIE = 'sampleify_csrf';

export function json(data, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function endpoint(work) {
  return async (request, context) => {
    try { return await work(request, context); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
      if (error.code === '23514' && error.constraint === 'sample_line_size_limit') return json({ error: { code: 'sample_line_size_limit', message: 'The repeated line-item values exceed the supported document size. Reduce the template or repeat count.' } }, 422);
      console.error('Request failed.', { code: /^[A-Z0-9_]{3,30}$/.test(error.code ?? '') ? error.code : 'internal_error' });
      return json({ error: { code: 'internal_error', message: 'The request could not be completed. Please try again.' } }, 500);
    }
  };
}

export function assertSameOrigin(request) {
  if (!process.env.APP_ORIGIN || request.headers.get('origin') !== new URL(process.env.APP_ORIGIN).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'invalid_origin', 'This request must come from the application.');
  }
}

export async function readInput(request, { maxBytes = 16_384 } = {}) {
  assertSameOrigin(request);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'invalid_content_type', 'A JSON request is required.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_input', 'Request body is required.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'input_too_large', 'Request is too large.'); }
    chunks.push(Buffer.from(value));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required');
    return value;
  } catch { throw new HttpError(400, 'invalid_input', 'Request body is invalid.'); }
}

export function authenticated(request, work, options = {}) {
  const mutation = !['GET', 'HEAD'].includes(request.method);
  if (mutation) assertSameOrigin(request);
  return withSession(request.cookies.get(SESSION_COOKIE)?.value, work, {
    ...options,
    ...(mutation ? { csrfToken: request.headers.get('x-csrf-token') ?? '' } : {}),
  });
}

export function setSessionCookies(response, session) {
  const options = { path: '/', sameSite: 'lax', secure: new URL(process.env.APP_ORIGIN).protocol === 'https:', expires: session.expiresAt };
  response.cookies.set(SESSION_COOKIE, session.token, { ...options, httpOnly: true });
  response.cookies.set(CSRF_COOKIE, session.csrfToken, { ...options, httpOnly: false });
}

export function clearSessionCookies(response) {
  const options = { path: '/', sameSite: 'lax', secure: new URL(process.env.APP_ORIGIN).protocol === 'https:', expires: new Date(0) };
  response.cookies.set(SESSION_COOKIE, '', { ...options, httpOnly: true });
  response.cookies.set(CSRF_COOKIE, '', { ...options, httpOnly: false });
}

export async function currentIdentity() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  try { return await withSession(token, (_client, identity) => publicIdentity(identity), { readOnly: true, accountAction: true }); }
  catch (error) { if (error.status === 401) return null; throw error; }
}
