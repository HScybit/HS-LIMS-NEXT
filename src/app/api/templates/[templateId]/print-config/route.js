import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { saveTemplatePrintConfig } from '@/templates/print-config.js';

export const PUT = endpoint(async (request, context) => {
  const { templateId } = await context.params;
  const input = await readInput(request);
  const printConfig = await authenticated(request,
    (client, identity) => saveTemplatePrintConfig(client, identity.organization_id, templateId, input),
    { permission: 'templates.manage' });
  return json(printConfig);
});
