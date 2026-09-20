import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, uuid } from '../templates/input.js';
import { workflowCodeBase } from './metadata-input.js';

export function workflowCloneInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'sourceVersionId']);
  return { id: uuid(input.id, 'New workflow').toLowerCase(), requestId: uuid(input.requestId, 'Clone request').toLowerCase(),
    sourceVersionId: input.sourceVersionId === undefined ? null : uuid(input.sourceVersionId, 'Source version').toLowerCase() };
}

const errors = {
  workflow_metadata_session_required: [403, 'forbidden', 'Your workflow management access changed. Sign in again before cloning.'],
  workflow_metadata_not_found: [404, 'workflow_not_found', 'Workflow was not found.'],
  workflow_metadata_identity_exists: [409, 'workflow_exists', 'This workflow already exists. Reload before cloning.'],
  workflow_metadata_stale: [409, 'stale_workflow_metadata', 'Workflow details changed before cloning. Reload and try again.'],
  workflow_metadata_input: [400, 'invalid_workflow_input', 'The workflow details cannot be copied.'],
  workflow_clone_input: [400, 'invalid_workflow_clone', 'The workflow clone request is invalid.'],
  workflow_clone_request_reused: [409, 'save_request_reused', 'This clone request was already used for a different change.'],
  workflow_clone_version_required: [409, 'workflow_version_required', 'This workflow has no version to clone.'],
  workflow_clone_invalid_version: [422, 'invalid_workflow_version', 'The selected version does not belong to this workflow.'],
  workflow_clone_name_too_long: [409, 'workflow_clone_name_too_long', 'Shorten the workflow name before cloning.'],
};

export async function cloneWorkflowMaster(client, identity, workflowId, input) {
  requirePermission(identity, 'workflows.manage');
  const sourceId = uuid(workflowId, 'Source workflow').toLowerCase(); const command = workflowCloneInput(input);
  // Read retired sources as well: an exact successful retry remains valid after
  // retirement. The locked SQL command checks current activity for a new clone.
  const source = (await client.query('SELECT code,metadata_revision FROM workflows WHERE organization_id=$1 AND id=$2',
    [identity.organization_id, sourceId])).rows[0];
  try {
    const result = await client.query('SELECT * FROM workflow_master_clone($1,$2,$3,$4,$5,$6)',
      [sourceId, command.id, command.requestId, command.sourceVersionId, source?.metadata_revision ?? null,
        source ? workflowCodeBase(`${source.code}-COPY`) : null]);
    const row = result.rows[0];
    return { workflowId: row.workflow_id, versionId: row.version_id, metadataRevision: row.metadata_revision, revision: row.revision };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw error;
  }
}
