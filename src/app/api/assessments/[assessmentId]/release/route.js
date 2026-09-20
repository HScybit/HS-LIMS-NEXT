import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { releaseAssessment } from '@/assessments/service.js';

export const POST = endpoint(async (request, context) => {
  const { assessmentId } = await context.params; const input = await readInput(request); fieldsOnly(input, ['revision']);
  return json(await authenticated(request, (client, identity) => releaseAssessment(client, identity, assessmentId, input.revision)));
});
