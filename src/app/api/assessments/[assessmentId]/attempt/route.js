import { authenticated, endpoint, json } from '@/auth/http.js';
import { getAssessmentForAttempt, startAssessmentAttempt } from '@/assessments/service.js';

export const GET = endpoint(async (request, context) => {
  const { assessmentId } = await context.params;
  return json(await authenticated(request, (client, identity) => getAssessmentForAttempt(client, identity, assessmentId), { readOnly: true }));
});

export const POST = endpoint(async (request, context) => {
  const { assessmentId } = await context.params;
  return json(await authenticated(request, (client, identity) => startAssessmentAttempt(client, identity, assessmentId)), 201);
});
