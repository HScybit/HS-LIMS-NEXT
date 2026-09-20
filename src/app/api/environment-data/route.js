import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listEnvironmentData, createEnvironmentData } from '@/environment/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, listEnvironmentData, { readOnly: true })));

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createEnvironmentData(client, identity, input)), 201);
});
