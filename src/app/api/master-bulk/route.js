import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { requirePermission } from '@/templates/input.js';
import { findMasterBulkUpload, listMasterBulk, stageMasterBulk } from '@/masters/bulk-store.js';
import { readMasterBulkUpload } from '@/masters/bulk-upload.js';
import { masterBulkResource } from '@/masters/bulk-row.js';
import { prepareUserBulkDecoded } from '@/users/bulk-credentials.js';

export const GET = endpoint(async request => {
  const query = request.nextUrl.searchParams.get('query') || '{}';
  if (query.length > 16_000) throw new HttpError(413, 'input_too_large', 'List query is too large.');
  let input; try { input = JSON.parse(query); } catch { throw new HttpError(400, 'invalid_input', 'List query is invalid.'); }
  return json(await authenticated(request, (client, identity) => listMasterBulk(client, identity,
    request.nextUrl.searchParams.get('resource') ?? 'all', input), { readOnly: true }));
});

export const POST = endpoint(async request => {
  // Authorize before allocating a file reader/worker; validate the session again at persistence.
  await authenticated(request, (_client, identity) => requirePermission(identity, masterBulkResource(request.nextUrl.searchParams.get('resource')).permission), { readOnly: true });
  const { input, decoded } = await readMasterBulkUpload(request);
  if (input.resource === 'users') {
    const prior = await authenticated(request, (client, identity) => findMasterBulkUpload(client, identity, input), { readOnly: true });
    if (prior) return json(prior, 201);
    const prepared = await prepareUserBulkDecoded(decoded, { signal: request.signal });
    return json(await authenticated(request, (client, identity) => stageMasterBulk(client, identity, input, prepared.decoded,
      { credentials: prepared.credentials }), { permission: 'users.manage' }), 201);
  }
  return json(await authenticated(request, (client, identity) => stageMasterBulk(client, identity, input, decoded)), 201);
});
