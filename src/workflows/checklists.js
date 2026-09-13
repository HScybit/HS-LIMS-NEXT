import { HttpError } from '../auth/errors.js';
import { fieldsOnly, text } from '../templates/input.js';
import { boundedList, roleIds } from './input.js';

export async function workflowChecklistOptions(client, identity, input = {}) {
  if (!identity.permission_codes?.some((permission) => ['workflows.read', 'workflows.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view workflow checklists.');
  fieldsOnly(input, ['search', 'selectedIds']);
  const search = text(input.search, 'Checklist search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_workflow_input', 'Checklist search contains invalid text.');
  const selectedIds = roleIds(boundedList(input.selectedIds, 'Selected checklists'), 'Selected checklists');
  const rows = (await client.query(`SELECT id,name,is_active AS "isActive",revision FROM workflow_checklist_labels
    WHERE organization_id=$1 AND is_active AND name ILIKE $2 ORDER BY lower(name),id LIMIT 101`,
  [identity.organization_id, `%${search.replace(/[\\%_]/g, '\\$&')}%`])).rows;
  const selected = selectedIds.length ? (await client.query(`SELECT id,name,is_active AS "isActive",revision FROM workflow_checklist_labels
    WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY lower(name),id`, [identity.organization_id, selectedIds])).rows : [];
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100, selected };
}

export async function transitionChecklist(client, identity, existing, value, input) {
  if (value.checklistMasterId === undefined && existing?.checklistMasterId) {
    const checklist = (await client.query(`SELECT id,prompt,is_required AS "isRequired",display_order AS "displayOrder"
      FROM workflow_transition_checklist_items WHERE organization_id=$1 AND transition_id=$2 ORDER BY display_order,id`,
    [identity.organization_id, existing.id])).rows;
    if (input.checklist !== undefined && (value.checklist.length !== checklist.length || value.checklist.some((item, index) => {
      const saved = checklist[index];
      const samePrompt = item.prompt === saved.prompt || input.checklist[index].prompt === saved.prompt;
      return (item.id !== undefined && item.id !== saved.id) || !samePrompt || item.isRequired !== saved.isRequired;
    }))) throw new HttpError(422, 'bound_workflow_checklist', 'Select a checklist or clear Node Checklist before changing its line items.');
    return { checklistMasterId: existing.checklistMasterId, checklistMasterRevision: existing.checklistMasterRevision, checklist };
  }
  if (!value.checklistMasterId) return { checklistMasterId: null, checklistMasterRevision: null, checklist: value.checklist };
  let rows;
  try { rows = (await client.query('SELECT * FROM workflow_select_checklist($1)', [value.checklistMasterId])).rows; }
  catch (error) {
    if (error.constraint === 'workflow_metadata_session_required') throw new HttpError(403, 'forbidden', 'Your workflow management access changed. Sign in again before saving.');
    if (error.constraint === 'workflow_checklist_unavailable') throw new HttpError(422, 'invalid_workflow_checklist', 'The selected checklist is inactive, unavailable or has invalid line items.');
    throw error;
  }
  if (!rows.length || rows.length > 200 || rows.some((item) => item.prompt.length > 500 || !item.prompt.trim())) {
    throw new HttpError(422, 'invalid_workflow_checklist', 'The selected checklist requires 1 to 200 nonempty line items of at most 500 characters.');
  }
  return { checklistMasterId: value.checklistMasterId, checklistMasterRevision: rows[0].master_revision || null,
    checklist: rows.map((item, displayOrder) => ({ prompt: item.prompt, isRequired: true, displayOrder })) };
}
