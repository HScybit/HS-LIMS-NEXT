import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { cloneTemplate } from '@/templates/authoring.js';
import { fieldsOnly } from '@/templates/input.js';

export const POST = endpoint(async (request, context) => {
  const { versionId } = await context.params; fieldsOnly(await readInput(request), []);
  return json(await authenticated(request, (client, identity) => cloneTemplate(client, identity, versionId), { permission: 'templates.manage' }), 201);
});
