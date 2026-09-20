import { HttpError } from '../auth/errors.js';
import { bool, dateOnly, fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some(permission => ['users.read', 'users.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view units.');
}
function unitText(value, label, limit, optional = false) {
  const result = text(typeof value === 'string' ? value.trim() : value, label, limit, { optional });
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} contains invalid text.`);
  return result;
}
export function businessUnitInput(input) {
  fieldsOnly(input, ['id', 'revision', 'requestId', 'code', 'name', 'description', 'active']);
  const code = unitText(input.code, 'Code', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(code)) throw new HttpError(400, 'invalid_unit_code', 'Code must start with a letter or number and contain only letters, numbers, dots, underscores, slashes or hyphens.');
  return { id: uuid(input.id, 'Unit').toLowerCase(), revision: integer(input.revision, 'Revision', 0, 2_147_483_646),
    requestId: uuid(input.requestId, 'Save request').toLowerCase(), code, name: unitText(input.name, 'Name', 200),
    description: unitText(input.description, 'Description', 2000, true) || null, active: bool(input.active === undefined ? true : input.active, 'Active') };
}
export async function loadBusinessUnit(client, identity, unitId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(unitId, 'Unit').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const result = await client.query(`SELECT ${history ? 'unit_id' : 'id'} AS id,revision,code,name,description,active
    ${history ? ',request_id AS "requestId",previous_revision AS "previousRevision",saved_by AS "savedBy",saved_by_name AS "savedByName",saved_at AS "savedAt"' : ',created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'business_unit_history' : 'business_unit_directory'}
    WHERE organization_id=$1 AND ${history ? 'unit_id' : 'id'}=$2 ${history ? 'AND revision=$3' : ''}`,
  history ? [identity.organization_id, id, atRevision] : [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'business_unit_not_found', 'Unit was not found.');
  return result.rows[0];
}
export async function saveBusinessUnit(client, identity, value) {
  requirePermission(identity, 'users.manage'); const input = businessUnitInput(value);
  let revision;
  try {
    revision = (await client.query('SELECT users_write_business_unit($1,$2,$3,$4,$5,$6,$7) AS revision',
      [input.id, input.revision, input.requestId, input.code, input.name, input.description, input.active])).rows[0].revision;
  } catch (error) {
    const errors = {
      business_units_code_key: [409, 'business_unit_code_exists', 'A unit with this code already exists.'],
      business_unit_request_reused: [409, 'save_request_reused', 'This save request was already used for another change.'],
      business_unit_stale: [409, 'stale_business_unit', 'The unit changed. Reload before saving.'],
      business_unit_not_found: [404, 'business_unit_not_found', 'Unit was not found.'],
      business_unit_invalid_input: [400, 'invalid_input', 'Unit details are invalid.'],
      user_profile_session_required: [403, 'forbidden', 'An active user management session is required.'],
    };
    throw errors[error.constraint] ? new HttpError(...errors[error.constraint]) : error;
  }
  return loadBusinessUnit(client, identity, input.id, { atRevision: revision });
}

const columns = { code: 'unit.code', name: 'unit.name', description: 'unit.description', active: 'unit.active', created_at: 'unit.created_at' };
const literal = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
export async function listBusinessUnits(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = unitText(input.search, 'Search', 500, true); const args = [identity.organization_id]; const conditions = ['unit.organization_id=$1'];
  const bind = value => { args.push(value); return `$${args.length}`; };
  if (search) { const value = bind(literal(search)); conditions.push(`(unit.code ILIKE ${value} OR unit.name ILIKE ${value} OR unit.description ILIKE ${value})`); }
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    if (key === 'created_at') {
      fieldsOnly(filter, ['type', 'from', 'to']);
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Created At requires calendar dates.');
      const from = filter.from == null || filter.from === '' ? null : dateOnly(filter.from); const to = filter.to == null || filter.to === '' ? null : dateOnly(filter.to);
      if (from && to && from > to) throw new HttpError(400, 'invalid_filter', 'The date range is reversed.');
      if (from) conditions.push(`unit.created_at>=${bind(from + 'T00:00:00Z')}::timestamptz`);
      if (to) conditions.push(`unit.created_at<(${bind(to + 'T00:00:00Z')}::timestamptz+interval '24 hours')`);
    } else {
      fieldsOnly(filter, ['type', 'value']);
      if (key === 'active') {
        if (filter.type !== 'boolean' || !['true', 'false'].includes(filter.value)) throw new HttpError(400, 'invalid_filter', 'Active requires Yes or No.');
        conditions.push(`unit.active=${bind(filter.value === 'true')}`);
      } else {
        if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Unit text filters require text.');
        const value = unitText(filter.value, 'Filter', 500, true); if (value) conditions.push(`${columns[key]} ILIKE ${bind(literal(value).replace(/\s+/g, '%'))}`);
      }
    }
  }
  if (input.sort) {
    fieldsOnly(input.sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, input.sort.key) || !['asc', 'desc'].includes(input.sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const order = input.sort ? `${columns[input.sort.key]} ${input.sort.dir}` : 'unit.created_at DESC';
  const where = conditions.join(' AND ');
  const totalCount = Number((await client.query(`SELECT count(*) AS count FROM business_unit_directory unit WHERE ${where}`, args)).rows[0].count);
  const rows = (await client.query(`SELECT unit.id AS _id,unit.code,unit.name,unit.description,unit.active,unit.revision,unit.created_at
    FROM business_unit_directory unit WHERE ${where} ORDER BY ${order},unit.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}
