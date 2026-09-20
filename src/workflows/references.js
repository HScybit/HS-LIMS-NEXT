import { HttpError } from '../auth/errors.js';
import { fieldsOnly, text, requirePermission, uuid } from '../templates/input.js';
import { roleIds } from './input.js';

const relations = Object.freeze({ roles: 'workflow_role_labels', templates: 'workflow_template_labels' });

export function workflowReferenceInput(kind, input = {}) {
  if (!Object.hasOwn(relations, kind)) throw new HttpError(400, 'invalid_workflow_reference', 'Select workflow roles or templates.');
  fieldsOnly(input, ['search', 'selectedIds']);
  const search = text(input.search, 'Reference search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_workflow_input', 'Reference search contains invalid text.');
  return { search, selectedIds: roleIds(input.selectedIds, 'Selected references') };
}

export async function workflowReferenceOptions(client, identity, kind, input = {}) {
  if (!identity.permission_codes?.some((permission) => ['workflows.read', 'workflows.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view workflow references.');
  }
  const { search, selectedIds } = workflowReferenceInput(kind, input); const relation = relations[kind];
  const rows = (await client.query(`SELECT id,name,active FROM ${relation}
    WHERE organization_id=$1 AND active AND name ILIKE $2 ORDER BY lower(name),id LIMIT 101`,
  [identity.organization_id, `%${search.replace(/[\\%_]/g, '\\$&')}%`])).rows;
  const selected = selectedIds.length ? (await client.query(`SELECT id,name,active FROM ${relation}
    WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY lower(name),id`, [identity.organization_id, selectedIds])).rows : [];
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100, selected };
}

export async function selectWorkflowTemplate(client, identity, templateId) {
  requirePermission(identity, 'workflows.manage'); uuid(templateId, 'Template');
  try { return (await client.query('SELECT workflow_select_template($1) AS id', [templateId])).rows[0].id; }
  catch (error) {
    if (error.constraint === 'workflow_metadata_session_required') throw new HttpError(403, 'forbidden', 'Your workflow management access changed. Sign in again before saving.');
    if (error.constraint === 'workflow_template_unavailable') throw new HttpError(422, 'invalid_workflow_template', 'The selected template is inactive or unavailable.');
    throw error;
  }
}
