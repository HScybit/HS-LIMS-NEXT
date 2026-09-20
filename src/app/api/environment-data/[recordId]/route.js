import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { getEnvironmentData, updateEnvironmentData, deleteEnvironmentData } from '@/environment/service.js';

export const GET = endpoint(async (request, context) => {
  const { recordId } = await context.params;
  return json(await authenticated(request, (client, identity) => getEnvironmentData(client, identity, recordId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { recordId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateEnvironmentData(client, identity, recordId, input)));
});

export const DELETE = endpoint(async (request, context) => {
  const { recordId } = await context.params; const input = await readInput(request); fieldsOnly(input, ['revision']);
  return json(await authenticated(request, (client, identity) => deleteEnvironmentData(client, identity, recordId, input.revision)));
});
