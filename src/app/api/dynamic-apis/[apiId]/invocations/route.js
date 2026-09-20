import { authenticated, endpoint, json } from '@/auth/http.js';
import { listDynamicApiInvocations } from '@/dynamic-apis/service.js';

export const GET = endpoint(async (request, context) => {
  const { apiId } = await context.params;
  return json(await authenticated(request, (client, identity) => listDynamicApiInvocations(client, identity, apiId), { readOnly: true }));
});
