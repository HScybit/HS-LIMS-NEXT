import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { getTrainingSchedule, updateTrainingSchedule } from '@/training/service.js';

export const GET = endpoint(async (request, context) => {
  const { scheduleId } = await context.params;
  return json(await authenticated(request, (client, identity) => getTrainingSchedule(client, identity, scheduleId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { scheduleId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateTrainingSchedule(client, identity, scheduleId, input)));
});
