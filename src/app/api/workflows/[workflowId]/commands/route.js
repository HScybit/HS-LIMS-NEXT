import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { workflowCommandMaxBytes } from '@/workflows/command-input.js';
import { executeWorkflowEditorCommand } from '@/workflows/commands.js';

export const POST = endpoint(async (request, context) => {
  const { workflowId } = await context.params; const input = await readInput(request, { maxBytes: workflowCommandMaxBytes });
  return json(await authenticated(request, (client, identity) => executeWorkflowEditorCommand(client, identity, workflowId, input)));
});
