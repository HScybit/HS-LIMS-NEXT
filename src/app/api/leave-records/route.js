import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listLeaveRecords, createLeaveRecord } from '@/leave/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, listLeaveRecords, { readOnly: true })));

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createLeaveRecord(client, identity, input)), 201);
});
