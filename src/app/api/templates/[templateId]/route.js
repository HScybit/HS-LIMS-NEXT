import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadDefinition } from '@/templates/loader.js';
import { uuid } from '@/templates/input.js';
import { templateView } from '@/templates/transport.js';

export const GET = endpoint(async (request, context) => {
  const { templateId } = await context.params;
  uuid(templateId, 'Template');
  const requestedVersion = request.nextUrl.searchParams.get('version');
  if (requestedVersion) uuid(requestedVersion, 'Version');
  const { model, metrics, versions } = await authenticated(request,
    (client, identity) => loadDefinition(client, identity.organization_id, requestedVersion, { templateId }),
    { readOnly: true, permission: 'templates.read' });
  return json({ model: templateView(model), versions, metrics });
});
