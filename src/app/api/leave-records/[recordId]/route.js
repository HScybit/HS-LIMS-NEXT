import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { getLeaveRecord, updateLeaveRecord, deleteLeaveRecord } from '@/leave/service.js';

export const GET = endpoint(async (request, context) => {
  const { recordId } = await context.params;
  return json(await authenticated(request, (client, identity) => getLeaveRecord(client, identity, recordId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { recordId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateLeaveRecord(client, identity, recordId, input)));
});

export const DELETE = endpoint(async (request, context) => {
  const { recordId } = await context.params; const input = await readInput(request); fieldsOnly(input, ['revision']);
  return json(await authenticated(request, (client, identity) => deleteLeaveRecord(client, identity, recordId, input.revision)));
});
