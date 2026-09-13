import { HttpError } from '../auth/errors.js';
import { integer, requirePermission, uuid } from '../templates/input.js';
import { checklistInput, checklistRetirementInput, checklistListInput } from './input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['checklists.read', 'checklists.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view checklists.');
}

const commandErrors = {
  checklist_session_required: [403, 'forbidden', 'Your checklist management access changed. Sign in again before saving.'],
  checklist_invalid_input: [400, 'invalid_checklist_input', 'The checklist command is invalid.'],
  checklist_not_found: [404, 'checklist_not_found', 'Checklist was not found.'],
  checklist_identifier_exists: [409, 'checklist_exists', 'This checklist already exists. Reload before editing.'],
  checklists_pkey: [409, 'checklist_exists', 'This checklist already exists. Reload before editing.'],
  checklist_name_conflict: [409, 'duplicate_checklist_name', 'A checklist with this name already exists.'],
  checklist_request_reused: [409, 'save_request_reused', 'This request was already used for a different checklist change.'],
  checklist_save_request_key: [409, 'save_request_reused', 'This request was already used for a different checklist change.'],
  checklist_stale: [409, 'stale_checklist', 'The checklist changed in another session. Reload before saving.'],
};

async function writeChecklist(client, identity, operation, input) {
  requirePermission(identity, 'checklists.manage');
  try {
    const result = await client.query('SELECT checklists_write($1,$2,$3,$4,$5,$6,$7,$8) AS revision', [
      operation, input.id, input.revision, input.requestId, input.name ?? null, input.isActive ?? null,
      input.items?.map((item) => item.id) ?? null, input.items?.map((item) => item.prompt) ?? null,
    ]);
    return { id: input.id, revision: result.rows[0].revision };
  } catch (error) {
    const mapped = commandErrors[error.constraint];
    if (mapped) throw new HttpError(...mapped);
    throw error;
  }
}

export function createChecklist(client, identity, value) { return writeChecklist(client, identity, 'create', checklistInput(value, { create: true })); }
export function updateChecklist(client, identity, value) { return writeChecklist(client, identity, 'update', checklistInput(value)); }
export function retireChecklist(client, identity, value) { return writeChecklist(client, identity, 'retire', checklistRetirementInput(value)); }

export async function loadChecklist(client, identity, checklistId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(checklistId, 'Checklist').toLowerCase();
  const historical = atRevision !== undefined;
  if (historical) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const rows = (await client.query(`SELECT master.${historical ? 'checklist_id' : 'id'} AS id, master.name,master.is_active AS "isActive",master.revision,
    master.retired_at AS "retiredAt",${historical ? 'master.saved_by AS "savedBy",master.saved_at AS "savedAt",master.previous_revision AS "previousRevision",master.operation'
      : 'master.created_by AS "createdBy",master.created_at AS "createdAt",master.updated_by AS "updatedBy",master.updated_at AS "updatedAt"'},
    item.id AS "itemId",item.prompt,item.display_order AS "displayOrder"
    FROM ${historical ? 'checklist_versions' : 'checklists'} master LEFT JOIN ${historical ? 'checklist_version_items' : 'checklist_items'} item
      ON item.organization_id=master.organization_id AND item.checklist_id=master.${historical ? 'checklist_id' : 'id'} ${historical ? 'AND item.revision=master.revision' : ''}
    WHERE master.organization_id=$1 AND master.${historical ? 'checklist_id' : 'id'}=$2 ${historical ? 'AND master.revision=$3' : 'AND master.retired_at IS NULL'}
    ORDER BY item.display_order,item.id`, historical ? [identity.organization_id, id, atRevision] : [identity.organization_id, id])).rows;
  if (!rows.length) throw new HttpError(404, 'checklist_not_found', 'Checklist was not found.');
  const { itemId, prompt, displayOrder, ...master } = rows[0];
  void itemId; void prompt; void displayOrder;
  return { ...master, items: rows.filter((row) => row.itemId !== null).map((row) => ({ id: row.itemId, prompt: row.prompt, displayOrder: row.displayOrder })) };
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export async function listChecklists(client, identity, value = {}) {
  requireRead(identity); const input = checklistListInput(value);
  const args = [identity.organization_id]; const conditions = ['organization_id=$1', 'retired_at IS NULL'];
  if (input.search) { args.push(literalSearch(input.search)); conditions.push(`name ILIKE $${args.length}`); }
  if (input.nameFilter) { args.push(literalSearch(input.nameFilter).replace(/\s+/g, '%')); conditions.push(`name ILIKE $${args.length}`); }
  if (input.activeFilter !== undefined) { args.push(input.activeFilter); conditions.push(`is_active=$${args.length}`); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total FROM checklists ${where}`, args)).rows[0].total;
  const order = input.sort ? `${input.sort.key === 'isActive' ? 'is_active' : 'name'} ${input.sort.dir}` : 'created_at DESC NULLS LAST';
  args.push(input.pageSize, (input.page - 1) * input.pageSize);
  const rows = (await client.query(`SELECT id AS _id,name,is_active AS "isActive",revision FROM checklists ${where}
    ORDER BY ${order},id LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
  return { rows, totalCount };
}
