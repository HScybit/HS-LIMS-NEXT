import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { getAssessment, updateAssessment } from '@/assessments/service.js';

export const GET = endpoint(async (request, context) => {
  const { assessmentId } = await context.params;
  return json(await authenticated(request, (client, identity) => getAssessment(client, identity, assessmentId), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { assessmentId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => updateAssessment(client, identity, assessmentId, input)));
});
