import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { loadRole, updateRole, retireRole } from '@/roles/service.js';
import { fieldsOnly } from '@/templates/input.js';

export const GET = endpoint(async (request, context) => {
  const { roleId } = await context.params; const revision = request.nextUrl.searchParams.get('revision');
  return json(await authenticated(request, (client, identity) => loadRole(client, identity, roleId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { roleId } = await context.params; const input = await readInput(request, { maxBytes: 512 * 1024 });
  fieldsOnly(input, ['revision', 'requestId', 'name', 'description', 'defaultPath', 'permissionCodes', 'capabilityKeys']);
  return json(await authenticated(request, (client, identity) => updateRole(client, identity, { ...input, id: roleId }), { permission: 'roles.manage' }));
});

export const DELETE = endpoint(async (request, context) => {
  const { roleId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['revision', 'requestId']);
  return json(await authenticated(request, (client, identity) => retireRole(client, identity, { ...input, id: roleId }), { permission: 'roles.manage' }));
});
