import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { rejectWorkflowAssignment } from '@/workflows/requests.js';

export const POST = endpoint(async (request, context) => {
  const { assignmentId } = await context.params;
  const input = await readInput(request, { maxBytes: 64 * 1024 });
  return json(await authenticated(request, (client, identity) => rejectWorkflowAssignment(client, identity, assignmentId, input), { permission: 'approvals.respond' }));
});
