import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listDynamicApiTokens, createDynamicApiToken } from '@/dynamic-apis/service.js';

export const GET = endpoint(async (request, context) => {
  const { apiId } = await context.params;
  return json(await authenticated(request, (client, identity) => listDynamicApiTokens(client, identity, apiId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { apiId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createDynamicApiToken(client, identity, apiId, input)), 201);
});
