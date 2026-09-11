import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { loadDatasheet } from '@/datasheets/service.js';

export const GET = endpoint(async (request, context) => {
  const { datasheetId } = await context.params;
  const requestedRevision = request.nextUrl.searchParams.get('revision');
  if (requestedRevision !== null && !/^[1-9]\d*$/.test(requestedRevision)) throw new HttpError(400, 'invalid_revision', 'Capture revision is invalid.');
  const result = await authenticated(request, (client, identity) => loadDatasheet(client, identity, datasheetId,
    { sampleId: request.nextUrl.searchParams.get('sampleId'), ...(requestedRevision !== null ? { atRevision: Number(requestedRevision) } : {}) }), { readOnly: true });
  return json(result);
});
