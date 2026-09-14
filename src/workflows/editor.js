import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { loadWorkflowMaster } from './metadata.js';
import { loadWorkflowDefinition } from './definition.js';

export async function loadWorkflowEditor(client, identity, workflowId, { versionId } = {}) {
  const workflow = await loadWorkflowMaster(client, identity, workflowId);
  const canManage = identity.permission_codes.includes('workflows.manage');
  const selected = versionId === undefined
    ? canManage ? workflow.draftVersionId || workflow.publishedVersionId : workflow.publishedVersionId || workflow.draftVersionId
    : uuid(versionId, 'Workflow version').toLowerCase();
  if (!selected) throw new HttpError(404, 'workflow_version_not_found', 'This workflow has no available version.');
  // Check membership before loading another graph, even within the same tenant.
  if (!(await client.query('SELECT id FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND id=$3',
    [identity.organization_id, workflow.id, selected])).rowCount) {
    throw new HttpError(404, 'workflow_version_not_found', 'This workflow version was not found.');
  }
  const definition = await loadWorkflowDefinition(client, identity, selected);
  return { ...definition, workflow, metrics: { queryCount: definition.metrics.queryCount + 2 } };
}
