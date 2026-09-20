import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { getDynamicApi, updateDynamicApiDraft } from '@/dynamic-apis/service.js';

export const GET = endpoint(async (request, context) => {
  const { apiId } = await context.params;
  return json(await authenticated(request, (client, identity) => getDynamicApi(client, identity, apiId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { apiId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateDynamicApiDraft(client, identity, apiId, input)));
});
