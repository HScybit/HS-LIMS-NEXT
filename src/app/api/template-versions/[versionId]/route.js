import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { editTemplate } from '@/templates/authoring.js';
import { loadDefinition } from '@/templates/loader.js';
import { uuid, fieldsOnly } from '@/templates/input.js';
import { templateView } from '@/templates/transport.js';

export const GET = endpoint(async (request, context) => {
  const { versionId } = await context.params; uuid(versionId, 'Version');
  const result = await authenticated(request, (client, identity) => loadDefinition(client, identity.organization_id, versionId), { readOnly: true, permission: 'templates.read' });
  return json({ model: templateView(result.model), metrics: result.metrics });
});
export const PATCH = endpoint(async (request, context) => {
  const { versionId } = await context.params;
  const input = await readInput(request); fieldsOnly(input, ['revision', 'command']);
  const result = await authenticated(request, (client, identity) => editTemplate(client, identity, versionId, input.revision, input.command), { permission: 'templates.manage' });
  return json({ model: templateView(result.model), metrics: result.metrics });
});
