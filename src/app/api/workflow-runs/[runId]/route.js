import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadWorkflowRun } from '@/workflows/load.js';

export const GET = endpoint(async (request, context) => {
  const { runId } = await context.params;
  return json(await authenticated(request, (client, identity) => loadWorkflowRun(client, identity, runId), { readOnly: true }));
});
