import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listTrainingSchedules, createTrainingSchedule } from '@/training/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, listTrainingSchedules, { readOnly: true })));

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createTrainingSchedule(client, identity, input)), 201);
});
