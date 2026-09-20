import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadCustomField, retireCustomField } from '@/masters/custom-fields.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { fieldId } = await context.params;
  const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadCustomField(client, identity, fieldId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const DELETE = endpoint(async (request, context) => {
  const { fieldId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireCustomField(client, identity, { ...input, id: fieldId }), { permission: 'masters.manage' }));
});
