import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadTestParameter, retireTestParameter } from '@/masters/test-parameters.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { parameterId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadTestParameter(client, identity, parameterId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { parameterId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireTestParameter(client, identity, { ...input, id: parameterId }), { permission: 'masters.manage' }));
});
