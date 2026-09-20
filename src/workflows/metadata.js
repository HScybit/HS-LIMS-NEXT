import { HttpError } from '../auth/errors.js';
import { integer, requirePermission, uuid } from '../templates/input.js';
import { workflowMetadataInput, workflowRetirementInput, workflowListInput } from './metadata-input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['workflows.read', 'workflows.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view workflow management.');
  }
}

const errors = {
  workflow_metadata_session_required: [403, 'forbidden', 'Your workflow management access changed. Sign in again before saving.'],
  workflow_metadata_input: [400, 'invalid_workflow_input', 'The workflow command is invalid.'],
  workflow_metadata_not_found: [404, 'workflow_not_found', 'Workflow was not found.'],
  workflow_metadata_identity_exists: [409, 'workflow_exists', 'This workflow already exists. Reload before editing.'],
  workflow_code_key: [409, 'workflow_code_exists', 'A workflow with this code already exists.'],
  workflow_name_exists: [409, 'workflow_name_exists', 'A workflow with this name already exists.'],
  workflow_metadata_request_reused: [409, 'save_request_reused', 'This request was already used for a different workflow change.'],
  workflow_metadata_request_key: [409, 'save_request_reused', 'This request was already used for a different workflow change.'],
  workflow_metadata_stale: [409, 'stale_workflow_metadata', 'Workflow details changed in another session. Reload before saving.'],
  workflow_metadata_in_use: [409, 'workflow_in_use', 'This workflow is currently used and cannot be deleted.'],
  workflow_type_in_use: [409, 'workflow_type_immutable', 'A workflow used by runtime records or settings cannot change entity type.'],
};

async function write(client, identity, operation, input) {
  requirePermission(identity, 'workflows.manage');
  try {
    const result = await client.query('SELECT * FROM workflows_metadata_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
      operation, input.id, input.metadataRevision, input.requestId, input.name ?? null, input.description ?? null, input.description !== undefined,
      input.code ?? null, input.generatedCode ?? false, input.appliesTo ?? null, input.active ?? null,
    ]);
    const row = result.rows[0];
    return { workflowId: input.id, metadataRevision: row.metadata_revision, ...(row.initial_version_id ? { versionId: row.initial_version_id, revision: 1 } : {}) };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw error;
  }
}

export function createWorkflowMaster(client, identity, input) {
  return write(client, identity, 'create', workflowMetadataInput(input, { create: true }));
}
export function updateWorkflowMaster(client, identity, input) {
  return write(client, identity, 'update', workflowMetadataInput(input));
}
export function retireWorkflowMaster(client, identity, input) {
  return write(client, identity, 'retire', workflowRetirementInput(input));
}

const selected = `workflow.id,workflow.code,workflow.name,workflow.description,workflow.applies_to AS "appliesTo",workflow.active,
  workflow.metadata_revision AS "metadataRevision",workflow.created_at AS "createdAt",workflow.created_by AS "createdBy",
  workflow.updated_at AS "updatedAt",workflow.updated_by AS "updatedBy"`;
const versions = `LEFT JOIN workflow_versions draft ON draft.organization_id=workflow.organization_id AND draft.workflow_id=workflow.id AND draft.status='draft'
  LEFT JOIN workflow_versions published ON published.organization_id=workflow.organization_id AND published.workflow_id=workflow.id AND published.status='published'`;

export async function loadWorkflowMaster(client, identity, workflowId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(workflowId, 'Workflow').toLowerCase(); const org = identity.organization_id;
  let value;
  if (atRevision !== undefined) {
    integer(atRevision, 'Metadata revision', 1, 2_147_483_647);
    value = (await client.query(`SELECT workflow_id AS id,revision AS "metadataRevision",code,name,description,applies_to AS "appliesTo",active,
      previous_revision AS "previousRevision",operation,saved_by AS "savedBy",saved_at AS "savedAt"
      FROM workflow_metadata_versions WHERE organization_id=$1 AND workflow_id=$2 AND revision=$3`, [org, id, atRevision])).rows[0];
  } else {
    value = (await client.query(`SELECT ${selected},draft.id AS "draftVersionId",draft.number AS "draftVersionNumber",draft.revision AS "draftRevision",
      published.id AS "publishedVersionId",published.number AS "publishedVersionNumber"
      FROM workflows workflow ${versions} WHERE workflow.organization_id=$1 AND workflow.id=$2 AND workflow.active`, [org, id])).rows[0];
  }
  if (!value) throw new HttpError(404, 'workflow_not_found', 'Workflow was not found.');
  return value;
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export async function listWorkflows(client, identity, value = {}) {
  requireRead(identity); const input = workflowListInput(value);
  const args = [identity.organization_id]; const conditions = ['workflow.organization_id=$1', 'workflow.active'];
  if (input.search) { args.push(literalSearch(input.search)); conditions.push(`(workflow.name ILIKE $${args.length} OR workflow.description ILIKE $${args.length})`); }
  for (const field of ['name', 'description']) if (input[field]) {
    args.push(literalSearch(input[field]).replace(/\s+/g, '%')); conditions.push(`workflow.${field} ILIKE $${args.length}`);
  }
  for (const [field, operator] of [['from', '>='], ['to', '<=']]) if (input[field]) {
    args.push(input[field]); conditions.push(`workflow.created_at ${operator} $${args.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total FROM workflows workflow ${where}`, args)).rows[0].total;
  const order = input.sort ? `workflow.${input.sort.key} ${input.sort.dir}` : 'workflow.created_at DESC';
  args.push(input.pageSize, (input.page - 1) * input.pageSize);
  const rows = (await client.query(`SELECT ${selected},workflow.id AS _id,workflow.created_at,
    draft.id AS "draftVersionId",published.id AS "publishedVersionId"
    FROM (SELECT workflow.* FROM workflows workflow ${where} ORDER BY ${order},workflow.id LIMIT $${args.length - 1} OFFSET $${args.length}) workflow
    ${versions} ORDER BY ${order},workflow.id`, args)).rows;
  return { rows, totalCount };
}
