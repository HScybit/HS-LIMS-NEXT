import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadMethod, retireMethod } from '@/masters/methods.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { methodId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadMethod(client, identity, methodId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { methodId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireMethod(client, identity, { ...input, id: methodId }), { permission: 'masters.manage' }));
});
