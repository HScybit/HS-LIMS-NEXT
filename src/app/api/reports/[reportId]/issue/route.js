import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { issueReport } from '@/reports/service.js';
import { fieldsOnly } from '@/templates/input.js';

export const POST = endpoint(async (request, context) => {
  const { reportId } = await context.params;
  const input = await readInput(request); fieldsOnly(input, ['revision']);
  return json(await authenticated(request, (client, identity) => issueReport(client, identity, reportId, input.revision)));
});
