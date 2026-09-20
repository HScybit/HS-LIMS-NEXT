import { authenticated, endpoint, json } from '@/auth/http.js';
import { revokeDynamicApiToken } from '@/dynamic-apis/service.js';

export const DELETE = endpoint(async (request, context) => {
  const { apiId, tokenId } = await context.params;
  return json(await authenticated(request, (client, identity) => revokeDynamicApiToken(client, identity, apiId, tokenId)));
});
