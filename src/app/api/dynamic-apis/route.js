import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listDynamicApis, createDynamicApi } from '@/dynamic-apis/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, listDynamicApis, { readOnly: true })));

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createDynamicApi(client, identity, input)), 201);
});
