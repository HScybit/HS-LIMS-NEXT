import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadVendor, retireVendor } from '@/masters/vendors.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { vendorId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadVendor(client, identity, vendorId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { vendorId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireVendor(client, identity, { ...input, id: vendorId }), { permission: 'masters.manage' }));
});
