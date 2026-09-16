import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { customFieldColumnKey } from '../custom-fields/listing-values.js';
import { methodCustomFields } from './custom-fields.js';
import { loadMethodCustomFieldValues, prepareMethodCustomFieldValues, appendMethodCustomFieldValues, lockMethodCustomFieldCapture } from './method-custom-fields.js';
import { methodCustomFieldMatch, loadMethodListingValues } from './method-custom-field-listing.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['masters.read', 'masters.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view methods of analysis.');
}

export function methodInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'uuid', 'description', 'decimalScale', 'parseNumber', 'accessUserIds', 'customFields', 'customFieldTimeZone']);
  const name = text(input.name, 'Name', 200); const methodUuid = text(input.uuid, 'UUID', 100);
  const description = text(input.description, 'Description', 16000, { optional: true });
  if ([name, methodUuid, description].some((value) => value.includes('\0'))) throw new HttpError(400, 'invalid_input', 'Method text cannot contain null characters.');
  const users = input.accessUserIds === undefined ? [] : input.accessUserIds;
  if (!Array.isArray(users) || users.length > 500) throw new HttpError(400, 'invalid_method_users', 'Select at most 500 users.');
  const accessUserIds = users.map((value) => uuid(value, 'User').toLowerCase());
  if (new Set(accessUserIds).size !== accessUserIds.length) throw new HttpError(400, 'invalid_method_users', 'Each user can be selected only once.');
  const customFieldsProvided = Object.hasOwn(input, 'customFields');
  const customFields = customFieldsProvided ? customFieldValuesInput(input.customFields) : undefined;
  const zone = input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone);
  if (!customFieldsProvided && zone !== null) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
  return { id: uuid(input.id, 'Method').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name, uuid: methodUuid, description,
    decimalScale: integer(input.decimalScale === undefined ? 4 : input.decimalScale, 'Decimal places', 0, 12),
    parseNumber: bool(input.parseNumber === undefined ? false : input.parseNumber, 'Convert number'), accessUserIds,
    customFieldsProvided, customFields, customFieldTimeZone: zone };
}

// Preserve PERN's generated code independently of the unmodified visible UUID.
export function generatedMethodCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'METHOD';
}

export async function loadMethod(client, identity, methodId, { atRevision } = {}) {
  requireRead(identity); uuid(methodId, 'Method');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT ${history ? 'method_id' : 'id'} AS id,revision,code,method_uuid AS uuid,name,description,
    decimal_scale AS "decimalScale",parse_number AS "parseNumber",active,access_user_count AS "accessUserCount",
    custom_field_count AS "customFieldCount",custom_fields_provided AS "customFieldsProvided"
    ${history ? ',saved_by AS "savedBy",saved_at AS "savedAt",previous_revision AS "previousRevision",operation' : ''}
    FROM ${history ? 'method_versions' : 'methods_of_analysis'} WHERE organization_id=$1 AND ${history ? 'method_id' : 'id'}=$2
    ${history ? 'AND revision=$3' : 'AND active'}`, history ? [identity.organization_id, methodId, atRevision] : [identity.organization_id, methodId])).rows[0];
  if (!record) throw new HttpError(404, 'method_not_found', 'Method of Analysis was not found.');
  const accessUsers = (await client.query(`SELECT access.user_id AS id,label.display_name AS name,label.active
    FROM method_version_users access LEFT JOIN method_access_user_labels label ON label.organization_id=access.organization_id AND label.user_id=access.user_id
    WHERE access.organization_id=$1 AND access.method_id=$2 AND access.revision=$3 ORDER BY access.position`, [identity.organization_id, methodId, record.revision])).rows;
  const customFields = await loadMethodCustomFieldValues(client, identity, methodId, record.revision, record.customFieldCount);
  const customFieldTimeZone = record.customFieldsProvided ? customFields.find(field => ['date', 'date_time'].includes(field.fieldType))?.timeZone ?? null : null;
  return { ...record, accessUsers, accessUserIds: accessUsers.map((user) => user.id), customFields, customFieldTimeZone };
}

const authoredFields = (value) => ({ name: value.name, uuid: value.uuid, description: value.description, decimalScale: value.decimalScale,
  parseNumber: value.parseNumber, accessUserIds: value.accessUserIds, customFieldsProvided: value.customFieldsProvided,
  customFields: value.customFieldsProvided ? value.customFields.map(({ fieldId, fieldRevision, value }) => ({ fieldId, fieldRevision, value })) : undefined,
  customFieldTimeZone: value.customFieldTimeZone });

async function priorSave(client, identity, id, revision, requestId, operation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('method-save:'||$1::text||':'||$2::text,0))", [identity.organization_id, requestId]);
  const prior = (await client.query('SELECT method_id,revision,previous_revision,operation,saved_by FROM method_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (!prior) return null;
  if (prior.method_id !== id || (prior.previous_revision ?? 0) !== revision || prior.operation !== operation || prior.saved_by !== identity.user_id) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadMethod(client, identity, id, { atRevision: prior.revision });
}

async function appendUsers(client, organizationId, methodId, revision, userIds) {
  if (!userIds.length) return;
  await client.query(`INSERT INTO method_version_users(organization_id,method_id,revision,user_id,position)
    SELECT $1,$2,$3,user_id,position-1 FROM unnest($4::uuid[]) WITH ORDINALITY AS users(user_id,position)`, [organizationId, methodId, revision, userIds]);
}

export async function saveMethod(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = methodInput(value);
  await lockMethodCustomFieldCapture(client);
  const prior = await priorSave(client, identity, input.id, input.revision, input.requestId, input.revision ? 'update' : 'create');
  if (prior) {
    if (JSON.stringify(authoredFields(prior)) !== JSON.stringify(authoredFields(input))) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    return prior;
  }
  const current = (await client.query('SELECT revision,active,custom_field_count FROM methods_of_analysis WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'method_not_found', 'Method of Analysis was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_method', 'The method changed. Reload before saving.');
  const definitions = await methodCustomFields(client, identity);
  const previousFields = current ? await loadMethodCustomFieldValues(client, identity, input.id, current.revision, current.custom_field_count) : [];
  const capture = await prepareMethodCustomFieldValues(client, identity, { definitions, entries: input.customFields, timeZone: input.customFieldTimeZone, previousFields });
  if (input.accessUserIds.length) {
    const users = await client.query('SELECT user_id FROM method_access_user_labels WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) AND active', [identity.organization_id, input.accessUserIds]);
    if (users.rowCount !== input.accessUserIds.length) throw new HttpError(400, 'invalid_method_users', 'Select active users in this organization.');
  }
  const args = [identity.organization_id, input.id, input.name, input.uuid, input.description, input.decimalScale, input.parseNumber, input.accessUserIds.length, input.requestId,
    capture.count, capture.provided];
  try {
    if (!input.revision) await client.query(`INSERT INTO methods_of_analysis(organization_id,id,name,method_uuid,description,decimal_scale,parse_number,access_user_count,save_request_id,custom_field_count,custom_fields_provided,code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [...args, generatedMethodCode(input.uuid)]);
    else await client.query(`UPDATE methods_of_analysis SET name=$3,method_uuid=$4,description=$5,decimal_scale=$6,parse_number=$7,access_user_count=$8,
      save_request_id=$9,custom_field_count=$10,custom_fields_provided=$11,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
    await appendUsers(client, identity.organization_id, input.id, input.revision + 1, input.accessUserIds);
    await appendMethodCustomFieldValues(client, identity, input.id, input.revision + 1, capture);
    await client.query('SET CONSTRAINTS method_custom_fields_complete IMMEDIATE');
    await client.query('SET CONSTRAINTS method_custom_fields_complete DEFERRED');
  } catch (error) {
    if (error.constraint === 'method_custom_field_definition_set') throw new HttpError(409, 'method_custom_fields_changed', 'Custom Fields changed. Reload before saving.');
    if (error.constraint === 'method_custom_field_required') throw new HttpError(400, 'invalid_custom_field_value', 'Complete the required Custom Fields.');
    if (['method_custom_value_option', 'method_custom_value_option_fk', 'method_custom_value_user', 'method_custom_value_user_fk',
      'method_custom_value_attachment', 'method_custom_value_attachment_fk', 'method_custom_value_lookup', 'method_custom_value_lookup_fk'].includes(error.constraint)) {
      throw new HttpError(400, 'invalid_method_custom_field_reference', 'A Custom Field selection is no longer available.');
    }
    if (error.constraint === 'method_save_request_key') throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
    if (error.code === '23505') throw new HttpError(409, 'duplicate_method', 'The method UUID or its generated code is already in use.');
    if (error.constraint === 'method_active_user') throw new HttpError(400, 'invalid_method_users', 'Select active users in this organization.');
    throw error;
  }
  return loadMethod(client, identity, input.id);
}

export async function retireMethod(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['id', 'requestId', 'revision']);
  const id = uuid(input.id, 'Method').toLowerCase(); const requestId = uuid(input.requestId, 'Delete request').toLowerCase();
  const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  await lockMethodCustomFieldCapture(client);
  const prior = await priorSave(client, identity, id, revision, requestId, 'retire');
  if (prior) return { id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM methods_of_analysis WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'method_not_found', 'Method of Analysis was not found.');
  if (current.revision !== revision) throw new HttpError(409, 'stale_method', 'The method changed. Reload before deleting.');
  const previous = await loadMethod(client, identity, id);
  await client.query('UPDATE methods_of_analysis SET active=false,custom_fields_provided=false,revision=revision+1,updated_at=transaction_timestamp(),save_request_id=$3 WHERE organization_id=$1 AND id=$2', [identity.organization_id, id, requestId]);
  await appendUsers(client, identity.organization_id, id, revision + 1, previous.accessUserIds);
  return { id, revision: revision + 1 };
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const columnSearch = (value) => literalSearch(value).replace(/\s+/g, '%');
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

const listColumns = { name: 'method.name', description: 'method.description', uuid: 'method.method_uuid',
  decimal_places: 'method.decimal_scale', parse_num: 'method.parse_number', has_access: 'allowed.names' };
const accessNameMatch = (match) => `EXISTS (SELECT 1 FROM method_version_users access
  JOIN method_access_user_labels label ON label.organization_id=access.organization_id AND label.user_id=access.user_id
  WHERE access.organization_id=method.organization_id AND access.method_id=method.id AND access.revision=method.revision AND label.display_name ILIKE ${match})`;

export async function listMethods(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id];
  const conditions = ['method.organization_id=$1', 'method.active'];
  const customFields = await methodCustomFields(client, identity, { forListing: true });
  const customColumns = new Map(customFields.map(field => [customFieldColumnKey(field), field]));
  const bind = (value) => { args.push(value); return `$${args.length}`; };
  if (search) {
    const match = bind(literalSearch(search));
    const searchableFields = customFields.filter(field => field.showInFilter);
    const customMatch = searchableFields.length ? ` OR ${methodCustomFieldMatch(bind, searchableFields.map(field => field.id), search)}` : '';
    conditions.push(`(method.name ILIKE ${match} OR method.description ILIKE ${match} OR method.method_uuid ILIKE ${match} OR ${accessNameMatch(match)}${customMatch})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, [...Object.keys(listColumns), ...customFields.filter(field => field.showInFilter).map(customFieldColumnKey)]);
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, ['type', 'value']);
    if (customColumns.has(key)) {
      const field = customColumns.get(key);
      const expectedType = field.fieldType === 'select' && field.options.length ? 'select' : 'text';
      if (filter.type !== expectedType) throw new HttpError(400, 'invalid_filter', 'Custom Field filters require the configured control type.');
      const value = searchText(filter.value, 'Custom Field filter');
      if (value) conditions.push(methodCustomFieldMatch(bind, [field.id], value));
      continue;
    }
    if (key === 'parse_num') {
      if (filter.type !== 'boolean' || !['true', 'false'].includes(filter.value)) throw new HttpError(400, 'invalid_filter', 'Convert Number requires Yes or No.');
      conditions.push(`${listColumns[key]}=${bind(filter.value === 'true')}`);
    } else {
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Method filters require text.');
      const value = searchText(filter.value, 'Filter');
      if (value) {
        const match = bind(columnSearch(value));
        conditions.push(key === 'has_access' ? accessNameMatch(match) : `${listColumns[key]}::text ILIKE ${match}`);
      }
    }
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if ((!Object.hasOwn(listColumns, sort.key) && !customColumns.get(sort.key)?.showInList) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const customSort = customColumns.get(sort?.key);
  const order = customSort ? `CASE ordering_field.display_kind WHEN 'number' THEN 1 WHEN 'text' THEN 2 WHEN 'boolean' THEN 3 ELSE 0 END ${sort.dir},
    ordering_field.display_number ${sort.dir},ordering_field.display_text COLLATE "C" ${sort.dir},ordering_field.display_boolean ${sort.dir}`
    : sort ? `${listColumns[sort.key]} ${sort.dir} NULLS LAST` : 'method.created_at DESC';
  // Aggregate the selected labels in SQL; no per-row or per-user API lookups.
  const from = `FROM methods_of_analysis method LEFT JOIN LATERAL (
    SELECT string_agg(label.display_name, ', ' ORDER BY access.position) AS names
    FROM method_version_users access JOIN method_access_user_labels label ON label.organization_id=access.organization_id AND label.user_id=access.user_id
    WHERE access.organization_id=method.organization_id AND access.method_id=method.id AND access.revision=method.revision
  ) allowed ON true ${customSort ? `LEFT JOIN method_version_custom_fields ordering_field ON ordering_field.organization_id=method.organization_id
    AND ordering_field.method_id=method.id AND ordering_field.revision=method.revision AND ordering_field.field_id=${bind(customSort.id)}` : ''}
  WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT method.id AS _id,method.revision,method.name,method.description,method.method_uuid AS uuid,
    method.decimal_scale AS decimal_places,method.parse_number AS parse_num,allowed.names AS has_access ${from}
    ORDER BY ${order},method.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows: await loadMethodListingValues(client, identity, rows, customFields), totalCount };
}

export async function methodUsers(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'User search');
  const rows = (await client.query(`SELECT user_id AS id,display_name AS name FROM method_access_user_labels
    WHERE organization_id=$1 AND active AND display_name ILIKE $2 ORDER BY display_name,user_id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}
