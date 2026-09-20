import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { submitAssessmentAttempt } from '@/assessments/service.js';

export const POST = endpoint(async (request, context) => {
  const { attemptId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => submitAssessmentAttempt(client, identity, attemptId, input)));
});
