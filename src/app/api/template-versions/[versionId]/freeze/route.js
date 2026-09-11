import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { freezeTemplate } from '@/templates/authoring.js';
import { fieldsOnly } from '@/templates/input.js';

export const POST = endpoint(async (request, context) => {
  const { versionId } = await context.params;
  const input = await readInput(request); fieldsOnly(input, ['revision']);
  return json(await authenticated(request, (client, identity) => freezeTemplate(client, identity, versionId, input.revision), { permission: 'templates.manage' }));
});
