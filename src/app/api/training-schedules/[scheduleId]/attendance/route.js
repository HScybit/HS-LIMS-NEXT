import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listTrainingAttendance, recordTrainingAttendance } from '@/training/service.js';

export const GET = endpoint(async (request, context) => {
  const { scheduleId } = await context.params;
  return json(await authenticated(request, (client, identity) => listTrainingAttendance(client, identity, scheduleId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { scheduleId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => recordTrainingAttendance(client, identity, scheduleId, input)), 201);
});
