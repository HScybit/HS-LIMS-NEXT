import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadWorkflowEditor } from '@/workflows/editor.js';

export const GET = endpoint(async (request, context) => {
  const { workflowId } = await context.params; const versionId = request.nextUrl.searchParams.get('versionId');
  return json(await authenticated(request, (client, identity) => loadWorkflowEditor(client, identity, workflowId,
    versionId === null ? {} : { versionId }), { readOnly: true }));
});
