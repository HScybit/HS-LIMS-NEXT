import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { listAssessments, createAssessment } from '@/assessments/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, listAssessments, { readOnly: true })));

export const POST = endpoint(async (request) => {
  const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => createAssessment(client, identity, input)), 201);
});
