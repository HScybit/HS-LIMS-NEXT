import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { publishDynamicApi } from '@/dynamic-apis/service.js';

export const POST = endpoint(async (request, context) => {
  const { apiId } = await context.params; const input = await readInput(request); fieldsOnly(input, ['revision']);
  return json(await authenticated(request, (client, identity) => publishDynamicApi(client, identity, apiId, input.revision)));
});
