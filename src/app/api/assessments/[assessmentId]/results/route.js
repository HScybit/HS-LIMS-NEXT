import { authenticated, endpoint, json } from '@/auth/http.js';
import { listAssessmentResults } from '@/assessments/service.js';

export const GET = endpoint(async (request, context) => {
  const { assessmentId } = await context.params;
  return json(await authenticated(request, (client, identity) => listAssessmentResults(client, identity, assessmentId), { readOnly: true }));
});
