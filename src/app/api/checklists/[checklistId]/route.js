import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadChecklist, updateChecklist, retireChecklist } from '@/checklists/service.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { checklistId } = await context.params; const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadChecklist(client, identity, checklistId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { checklistId } = await context.params; const input = await readInput(request, { maxBytes: 512 * 1024 });
  fieldsOnly(input, ['revision', 'requestId', 'name', 'isActive', 'items']);
  return json(await authenticated(request, (client, identity) => updateChecklist(client, identity, { ...input, id: checklistId }), { permission: 'checklists.manage' }));
});

export const DELETE = endpoint(async (request, context) => {
  const { checklistId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireChecklist(client, identity, { ...input, id: checklistId }), { permission: 'checklists.manage' }));
});
