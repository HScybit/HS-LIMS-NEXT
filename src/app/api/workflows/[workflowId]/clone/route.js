import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { cloneWorkflowMaster } from '@/workflows/master-clone.js';

export const POST = endpoint(async (request, context) => {
  const { workflowId } = await context.params; const input = await readInput(request);
  return json(await authenticated(request, (client, identity) => cloneWorkflowMaster(client, identity, workflowId, input), { permission: 'workflows.manage' }), 201);
});
