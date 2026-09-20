import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, bool } from '../templates/input.js';

function checklistText(value, label, maximum, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_checklist_text', `${label} must be text.`);
  const result = value.trim();
  if ((!optional && !result) || result.length > maximum || !result.isWellFormed() || result.includes('\0')) {
    throw new HttpError(400, 'invalid_checklist_text', `${label} must contain ${optional ? 'at most' : '1 to'} ${maximum} valid characters.`);
  }
  return result;
}

function checklistItems(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new HttpError(400, 'invalid_checklist_items', 'Enter 1 to 200 line items.');
  const items = Array.from(value, (item) => {
    fieldsOnly(item, ['id', 'prompt']);
    return { id: uuid(item.id, 'Line item').toLowerCase(), prompt: checklistText(item.prompt, 'Line item', 500) };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new HttpError(400, 'invalid_checklist_items', 'Line item identifiers must be distinct.');
  // This is the source contract's Unicode lowercase comparison, independent of the database locale.
  if (new Set(items.map((item) => item.prompt.toLowerCase())).size !== items.length) throw new HttpError(400, 'duplicate_checklist_items', 'Checklist line items must be unique.');
  return items;
}

export function checklistInput(input, { create = false } = {}) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'isActive', 'items']);
  const result = { id: uuid(input.id, 'Checklist').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646),
    name: input.name === undefined ? undefined : checklistText(input.name, 'Name', 200),
    isActive: input.isActive === undefined ? undefined : bool(input.isActive, 'Is Active?'), items: checklistItems(input.items) };
  if (create && (result.revision !== 0 || result.name === undefined || result.items === undefined)) {
    throw new HttpError(400, 'invalid_checklist_input', 'New checklists require a name, line items and revision zero.');
  }
  return result;
}

export function checklistRetirementInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision']);
  return { id: uuid(input.id, 'Checklist').toLowerCase(), requestId: uuid(input.requestId, 'Delete request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646) };
}

export function checklistListInput(input = {}) {
  fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const filters = input.filters ?? {}; fieldsOnly(filters, ['name', 'isActive']);
  let nameFilter = '';
  if (filters.name !== undefined) {
    fieldsOnly(filters.name, ['type', 'value']);
    if (filters.name.type !== 'text') throw new HttpError(400, 'invalid_checklist_filter', 'Name filters require text.');
    nameFilter = checklistText(filters.name.value, 'Name filter', 500, true);
  }
  let activeFilter;
  if (filters.isActive !== undefined) {
    fieldsOnly(filters.isActive, ['type', 'value']);
    const { type, value } = filters.isActive;
    if (type !== 'boolean' || ![true, false, 'true', 'false'].includes(value)) throw new HttpError(400, 'invalid_checklist_filter', 'Is Active filters require Yes or No.');
    activeFilter = value === true || value === 'true';
  }
  if (input.sort != null) {
    fieldsOnly(input.sort, ['key', 'dir']);
    if (!['name', 'isActive'].includes(input.sort.key) || !['asc', 'desc'].includes(input.sort.dir)) throw new HttpError(400, 'invalid_checklist_sort', 'Select a supported checklist sort order.');
  }
  return { page: integer(input.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(input.pageSize ?? 10, 'Page size', 1, 100),
    search: checklistText(input.search, 'Search', 500, true), nameFilter, activeFilter, sort: input.sort ?? null };
}
