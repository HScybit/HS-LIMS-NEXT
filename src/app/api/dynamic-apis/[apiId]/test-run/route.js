import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { testRunDynamicApi } from '@/dynamic-apis/service.js';

export const POST = endpoint(async (request, context) => {
  const { apiId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => testRunDynamicApi(client, identity, apiId, input)));
});
