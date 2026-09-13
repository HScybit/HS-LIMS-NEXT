import { authenticated, endpoint, json, readInput } from '@/auth/http.js';
import { fieldsOnly } from '@/templates/input.js';
import { loadWorkflowMaster, updateWorkflowMaster, retireWorkflowMaster } from '@/workflows/metadata.js';

export const GET = endpoint(async (request, context) => {
  const { workflowId } = await context.params; const revision = request.nextUrl.searchParams.get('metadataRevision');
  return json(await authenticated(request, (client, identity) => loadWorkflowMaster(client, identity, workflowId,
    revision === null ? {} : { atRevision: Number(revision) }), { readOnly: true }));
});

export const PATCH = endpoint(async (request, context) => {
  const { workflowId } = await context.params; const input = await readInput(request, { maxBytes: 64 * 1024 });
  fieldsOnly(input, ['requestId', 'metadataRevision', 'name', 'description', 'code', 'appliesTo', 'active']);
  return json(await authenticated(request, (client, identity) => updateWorkflowMaster(client, identity, { ...input, id: workflowId }), { permission: 'workflows.manage' }));
});

export const DELETE = endpoint(async (request, context) => {
  const { workflowId } = await context.params; const input = await readInput(request);
  fieldsOnly(input, ['requestId', 'metadataRevision']);
  return json(await authenticated(request, (client, identity) => retireWorkflowMaster(client, identity, { ...input, id: workflowId }), { permission: 'workflows.manage' }));
});
