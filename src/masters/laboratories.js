import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';

const valueFields = ['code', 'name', 'description', 'abbreviation', 'businessUnitId', 'headUserId', 'delegateUserId',
  'minimumTemperature', 'maximumTemperature', 'minimumHumidity', 'maximumHumidity', 'active'];
function requireRead(identity) {
  if (!identity.permission_codes?.some(permission => ['users.read', 'users.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view labs.');
}
function sourceText(value, label, { required = false, maximum = 1_048_576 } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length > maximum || required && !value.trim()) throw new HttpError(400, 'invalid_input', `${label} is invalid.`);
  if (!value.isWellFormed() || value.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} contains invalid text.`);
  return value;
}
export function laboratoryInput(input) {
  fieldsOnly(input, ['id', 'revision', 'requestId', ...valueFields]);
  const result = { id: uuid(input.id, 'Lab').toLowerCase(), revision: integer(input.revision, 'Revision', 0, 2_147_483_646),
    requestId: uuid(input.requestId, 'Save request').toLowerCase(), code: sourceText(input.code, 'Code', { required: true }),
    name: sourceText(input.name, 'Name', { required: true }), description: sourceText(input.description, 'Description'), abbreviation: sourceText(input.abbreviation, 'Abbreviation'),
    active: bool(input.active === undefined ? true : input.active, 'Active') };
  for (const [key, label] of [['businessUnitId', 'Business unit'], ['headUserId', 'Head of Lab'], ['delegateUserId', 'Delegate Authority to']]) {
    result[key] = input[key] == null || input[key] === '' ? null : uuid(input[key], label).toLowerCase();
  }
  for (const [key, label] of [['minimumTemperature', 'Min Temperature'], ['maximumTemperature', 'Max Temperature'], ['minimumHumidity', 'Min Humidity'], ['maximumHumidity', 'Max Humidity']]) result[key] = sourceText(input[key], label);
  return result;
}
const selectedFields = `revision,code,name,description,abbreviation,active,business_unit_id AS "businessUnitId",business_unit_code AS "businessUnitCode",business_unit_name AS "businessUnitName",
  head_user_id AS "headUserId",head_username AS "headUsername",head_user_name AS "headUserName",delegate_user_id AS "delegateUserId",delegate_username AS "delegateUsername",delegate_user_name AS "delegateUserName",
  minimum_temperature_text AS "minimumTemperature",maximum_temperature_text AS "maximumTemperature",minimum_humidity_text AS "minimumHumidity",maximum_humidity_text AS "maximumHumidity"`;
export async function loadLaboratory(client, identity, laboratoryId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(laboratoryId, 'Lab').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const result = await client.query(`SELECT ${history ? 'laboratory_id' : 'id'} AS id,${selectedFields}
    ${history ? ',request_id AS "requestId",previous_revision AS "previousRevision",operation,saved_by AS "savedBy",saved_by_username AS "savedByUsername",saved_by_name AS "savedByName",saved_at AS "savedAt"' : ',created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'laboratory_history' : 'laboratory_directory'} WHERE organization_id=$1 AND ${history ? 'laboratory_id' : 'id'}=$2 ${history ? 'AND revision=$3' : ''}`,
  history ? [identity.organization_id, id, atRevision] : [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'laboratory_not_found', 'Lab was not found.');
  return result.rows[0];
}
async function writeLaboratory(client, identity, operation, input) {
  const args = [operation, input.id, input.revision, input.requestId, ...valueFields.map(key => operation === 'retire' ? null : input[key])];
  let revision;
  try { revision = (await client.query(`SELECT users_write_laboratory(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args)).rows[0].revision; }
  catch (error) {
    const errors = {
      laboratories_code_key: [409, 'laboratory_code_exists', 'A lab with this code already exists.'],
      laboratory_request_reused: [409, 'save_request_reused', 'This save request was already used for another change.'],
      laboratory_stale: [409, 'stale_laboratory', 'The lab changed. Reload before saving.'],
      laboratory_not_found: [404, 'laboratory_not_found', 'Lab was not found.'],
      laboratory_invalid_input: [400, 'invalid_input', 'Lab details are invalid. Check the name, code and four laboratory limits.'],
      laboratory_user_unavailable: [422, 'invalid_laboratory_user', 'Select a user in this organization.'],
      laboratory_unit_unavailable: [422, 'invalid_business_unit', 'Business unit is unavailable.'],
      user_profile_session_required: [403, 'forbidden', 'An active user management session is required.'],
    };
    throw errors[error.constraint] ? new HttpError(...errors[error.constraint]) : error;
  }
  return loadLaboratory(client, identity, input.id, { atRevision: revision });
}
export async function saveLaboratory(client, identity, value) {
  requirePermission(identity, 'users.manage'); return writeLaboratory(client, identity, 'save', laboratoryInput(value));
}
export async function retireLaboratory(client, identity, value) {
  requirePermission(identity, 'users.manage'); fieldsOnly(value, ['id', 'revision', 'requestId']);
  const input = { id: uuid(value.id, 'Lab').toLowerCase(), revision: integer(value.revision, 'Revision', 1, 2_147_483_646), requestId: uuid(value.requestId, 'Save request').toLowerCase() };
  return writeLaboratory(client, identity, 'retire', input);
}

const columns = { name: 'lab.name', abbreviation: 'lab.abbreviation', head_user_name: 'lab.head_user_name', delegate_user_name: 'lab.delegate_user_name',
  code: 'lab.code', description: 'lab.description', active: 'lab.active' };
const literal = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
export async function listLaboratories(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = sourceText(input.search, 'Search', { maximum: 500 })?.trim(); const args = [identity.organization_id]; const conditions = ['lab.organization_id=$1'];
  const bind = value => { args.push(value); return `$${args.length}`; };
  if (search) { const value = bind(literal(search)); conditions.push(`(${Object.entries(columns).filter(([key]) => key !== 'active').map(([, column]) => `${column} ILIKE ${value}`).join(' OR ')})`); }
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, ['type', 'value']);
    if (key === 'active') {
      if (filter.type !== 'boolean' || !['true', 'false'].includes(filter.value)) throw new HttpError(400, 'invalid_filter', 'Active requires Yes or No.');
      conditions.push(`lab.active=${bind(filter.value === 'true')}`);
    } else {
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Lab text filters require text.');
      const value = sourceText(filter.value, 'Filter', { maximum: 500 })?.trim();
      if (value) conditions.push(`${columns[key]} ILIKE ${bind(literal(value).replace(/\s+/g, '%'))}`);
    }
  }
  if (input.sort) {
    fieldsOnly(input.sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, input.sort.key) || !['asc', 'desc'].includes(input.sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const order = input.sort ? `${columns[input.sort.key]} ${input.sort.dir}` : 'lab.created_at DESC'; const where = conditions.join(' AND ');
  const totalCount = Number((await client.query(`SELECT count(*) AS count FROM laboratory_directory lab WHERE ${where}`, args)).rows[0].count);
  const rows = (await client.query(`SELECT lab.id AS _id,lab.name,lab.abbreviation,lab.head_user_name,lab.delegate_user_name,lab.code,lab.description,lab.active,lab.revision
    FROM laboratory_directory lab WHERE ${where} ORDER BY ${order},lab.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}
