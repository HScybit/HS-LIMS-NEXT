import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text, uuid, bool, dateOnly } from '../templates/input.js';

function workflowText(value, label, maximum, optional = false) {
  const result = text(value, label, maximum, { optional }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_workflow_text', `${label} contains invalid text.`);
  return result;
}

// PERN workflowFormConfig.normalizeCodePart. Collision suffixes are allocated
// inside the locked metadata command, using the complete tenant code set.
export function workflowCodeBase(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'WORKFLOW';
}

export function workflowMetadataInput(input, { create = false } = {}) {
  fieldsOnly(input, ['id', 'requestId', 'metadataRevision', 'name', 'description', 'code', 'appliesTo', 'active']);
  const name = workflowText(input.name, 'Name', 200);
  const metadataRevision = integer(input.metadataRevision, 'Metadata revision', 0, 2_147_483_646);
  if (create && metadataRevision !== 0) throw new HttpError(400, 'invalid_workflow_revision', 'New workflows start at metadata revision zero.');
  if (input.appliesTo !== undefined && !['sample', 'test_request', 'instrument_service', 'document'].includes(input.appliesTo)) throw new HttpError(400, 'invalid_workflow_type', 'Select a supported workflow type.');
  return { id: uuid(input.id, 'Workflow').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(), metadataRevision, name,
    description: input.description === undefined ? undefined : workflowText(input.description, 'Description', 10000, true),
    code: input.code === undefined ? (create ? workflowCodeBase(name) : undefined) : workflowText(input.code, 'Code', 64),
    generatedCode: create && input.code === undefined, appliesTo: input.appliesTo ?? (create ? 'sample' : undefined),
    active: input.active === undefined ? undefined : bool(input.active, 'Active') };
}

export function workflowRetirementInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'metadataRevision']);
  return { id: uuid(input.id, 'Workflow').toLowerCase(), requestId: uuid(input.requestId, 'Delete request').toLowerCase(),
    metadataRevision: integer(input.metadataRevision, 'Metadata revision', 0, 2_147_483_646) };
}

export function workflowListInput(input = {}) {
  fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const filters = input.filters ?? {}; fieldsOnly(filters, ['name', 'description', 'created_at']);
  const result = { page: integer(input.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(input.pageSize ?? 10, 'Page size', 1, 100),
    search: workflowText(input.search, 'Search', 500, true), sort: input.sort ?? null };
  for (const field of ['name', 'description']) if (filters[field] !== undefined) {
    fieldsOnly(filters[field], ['type', 'value']);
    if (filters[field].type !== 'text') throw new HttpError(400, 'invalid_workflow_filter', 'Workflow text filters require text.');
    result[field] = workflowText(filters[field].value, 'Filter', 500, true);
  }
  if (filters.created_at !== undefined) {
    const filter = filters.created_at; fieldsOnly(filter, ['type', 'from', 'to']);
    if (filter.type !== 'date') throw new HttpError(400, 'invalid_workflow_filter', 'Created At filters require dates.');
    // Preserve generic.list's server-local day boundaries.
    for (const field of ['from', 'to']) if (filter[field] !== undefined && filter[field] !== null && filter[field] !== '') {
      const date = new Date(dateOnly(filter[field]));
      if (field === 'from') date.setHours(0, 0, 0, 0); else date.setHours(23, 59, 59, 999);
      result[field] = date;
    }
    if (result.from && result.to && result.from > result.to) throw new HttpError(400, 'invalid_workflow_filter', 'The start date must not follow the end date.');
  }
  if (result.sort !== null) {
    fieldsOnly(result.sort, ['key', 'dir']);
    if (!['name', 'description', 'created_at'].includes(result.sort.key) || !['asc', 'desc'].includes(result.sort.dir)) {
      throw new HttpError(400, 'invalid_workflow_sort', 'Select a supported workflow sort order.');
    }
  }
  return result;
}
