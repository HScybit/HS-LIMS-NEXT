import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';
import { normalizeUncertaintyGrid } from './parameter-grid.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { parameterCustomFields } from './custom-fields.js';
import { loadParameterCustomFieldValues, prepareParameterCustomFieldValues, appendParameterCustomFieldValues } from './parameter-custom-fields.js';
import { parameterCustomFieldMatch, loadParameterListingValues } from './parameter-custom-field-listing.js';
import { customFieldColumnKey } from '../custom-fields/listing-values.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['masters.read', 'masters.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view test parameters.');
}
const keyText = (value, label) => {
  const normalized = text(value, label, 64);
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new HttpError(400, 'invalid_parameter_key', `${label} contains unsupported characters.`);
  return normalized;
};

export function testParameterInput(input) {
  fieldsOnly(input, ['id', 'revision', 'requestId', 'name', 'description', 'key', 'schemeAbbreviation', 'order', 'laboratoryId', 'measurementUncertainty', 'customFields', 'customFieldTimeZone']);
  const name = text(input.name, 'Parameter name', 200); const description = text(input.description, 'Description', 16000, { optional: true });
  if (name.includes('\0') || description.includes('\0')) throw new HttpError(400, 'invalid_input', 'Parameter text cannot contain null characters.');
  const customFieldsProvided = Object.hasOwn(input, 'customFields');
  const customFields = customFieldsProvided ? customFieldValuesInput(input.customFields) : undefined;
  const zone = input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone);
  if (!customFieldsProvided && zone !== null) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
  return { id: uuid(input.id, 'Parameter').toLowerCase(), revision: integer(input.revision, 'Revision', 0, 2_147_483_646),
    requestId: uuid(input.requestId, 'Save request').toLowerCase(), name, description, key: keyText(input.key, 'Key'),
    schemeAbbreviation: keyText(input.schemeAbbreviation, 'Scheme abbreviation'), order: integer(input.order === undefined ? 0 : input.order, 'Order', 0, 2_147_483_647),
    laboratoryId: input.laboratoryId == null || input.laboratoryId === '' ? null : uuid(input.laboratoryId, 'Lab').toLowerCase(),
    measurementUncertainty: normalizeUncertaintyGrid(input.measurementUncertainty), customFieldsProvided, customFields, customFieldTimeZone: zone };
}

async function loadGrid(client, organizationId, parameterId, revision) {
  const args = [organizationId, parameterId, revision];
  const columns = (await client.query('SELECT id,title FROM parameter_uncertainty_columns WHERE organization_id=$1 AND parameter_id=$2 AND revision=$3 ORDER BY position', args)).rows;
  const rows = (await client.query('SELECT id FROM parameter_uncertainty_rows WHERE organization_id=$1 AND parameter_id=$2 AND revision=$3 ORDER BY position', args)).rows;
  const cells = (await client.query('SELECT row_id,column_id,text_value FROM parameter_uncertainty_cells WHERE organization_id=$1 AND parameter_id=$2 AND revision=$3', args)).rows;
  const values = new Map(cells.map((cell) => [`${cell.row_id}:${cell.column_id}`, cell.text_value]));
  return normalizeUncertaintyGrid({ columns, rows: rows.map((row) => ({ id: row.id, values: columns.slice(1).map((column) => values.get(`${row.id}:${column.id}`)) })) });
}

async function appendGrid(client, organizationId, parameterId, revision, grid) {
  if (!grid) return;
  const args = [organizationId, parameterId, revision];
  await client.query(`INSERT INTO parameter_uncertainty_columns(organization_id,parameter_id,revision,id,position,title)
    SELECT $1,$2,$3,id,position-1,title FROM unnest($4::uuid[],$5::text[]) WITH ORDINALITY AS columns(id,title,position)`,
  [...args, grid.columns.map((column) => column.id), grid.columns.map((column) => column.title)]);
  await client.query(`INSERT INTO parameter_uncertainty_rows(organization_id,parameter_id,revision,id,position)
    SELECT $1,$2,$3,id,position-1 FROM unnest($4::uuid[]) WITH ORDINALITY AS rows(id,position)`, [...args, grid.rows.map((row) => row.id)]);
  const rowIds = []; const columnIds = []; const values = [];
  for (const row of grid.rows) for (const [index, column] of grid.columns.slice(1).entries()) {
    rowIds.push(row.id); columnIds.push(column.id); values.push(row.values[index]);
  }
  await client.query(`INSERT INTO parameter_uncertainty_cells(organization_id,parameter_id,revision,row_id,column_id,text_value)
    SELECT $1,$2,$3,row_id,column_id,value FROM unnest($4::uuid[],$5::uuid[],$6::text[]) AS cells(row_id,column_id,value)`, [...args, rowIds, columnIds, values]);
}

export async function loadTestParameter(client, identity, parameterId, { atRevision } = {}) {
  requireRead(identity); uuid(parameterId, 'Parameter');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT parameter.${history ? 'parameter_id' : 'id'} AS id,parameter.revision,parameter.code,parameter.name,parameter.description,
    parameter.master_key AS key,parameter.scheme_abbreviation AS "schemeAbbreviation",parameter.display_order AS "order",parameter.active,
    parameter.laboratory_id AS "laboratoryId",lab.name AS "laboratoryName",parameter.measurement_unit_id AS "measurementUnitId",parameter.default_scale AS "defaultScale",
    parameter.${history ? 'has_uncertainty' : 'uncertainty_configured'} AS "hasUncertainty",
    parameter.custom_field_count AS "customFieldCount",parameter.custom_fields_provided AS "customFieldsProvided"
    ${history ? ',parameter.saved_by AS "savedBy",parameter.saved_at AS "savedAt",parameter.previous_revision AS "previousRevision",parameter.operation' : ''}
    FROM ${history ? 'test_parameter_versions' : 'test_parameters'} parameter
    LEFT JOIN laboratories lab ON lab.organization_id=parameter.organization_id AND lab.id=parameter.laboratory_id
    WHERE parameter.organization_id=$1 AND parameter.${history ? 'parameter_id' : 'id'}=$2 ${history ? 'AND parameter.revision=$3' : 'AND parameter.active'}`,
  history ? [identity.organization_id, parameterId, atRevision] : [identity.organization_id, parameterId])).rows[0];
  if (!record) throw new HttpError(404, 'parameter_not_found', 'Test parameter was not found.');
  const measurementUncertainty = record.hasUncertainty ? await loadGrid(client, identity.organization_id, parameterId, record.revision) : null;
  const methods = (await client.query(`SELECT method_id AS "methodId",is_default AS "isDefault" FROM ${history ? 'test_parameter_version_methods' : 'parameter_methods'}
    WHERE organization_id=$1 AND ${history ? 'parameter_id' : 'test_parameter_id'}=$2 ${history ? 'AND revision=$3' : ''} ORDER BY method_id`,
  history ? [identity.organization_id, parameterId, record.revision] : [identity.organization_id, parameterId])).rows;
  const customFields = await loadParameterCustomFieldValues(client, identity, parameterId, record.revision, record.customFieldCount);
  const customFieldTimeZone = record.customFieldsProvided ? customFields.find((field) => ['date', 'date_time'].includes(field.fieldType))?.timeZone ?? null : null;
  return { ...record, measurementUncertainty, methods, customFields, customFieldTimeZone };
}

const authoredFields = (value) => ({ name: value.name, description: value.description, key: value.key, schemeAbbreviation: value.schemeAbbreviation,
  order: value.order, laboratoryId: value.laboratoryId, measurementUncertainty: value.measurementUncertainty,
  customFieldsProvided: value.customFieldsProvided,
  customFields: value.customFieldsProvided ? value.customFields.map(({ fieldId, fieldRevision, value }) => ({ fieldId, fieldRevision, value })) : undefined,
  customFieldTimeZone: value.customFieldTimeZone });

async function priorSave(client, identity, parameterId, revision, requestId, operation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('parameter-save:'||$1::text||':'||$2::text,0))", [identity.organization_id, requestId]);
  const prior = (await client.query('SELECT parameter_id,revision,previous_revision,saved_by,operation FROM test_parameter_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (!prior) return null;
  if (prior.parameter_id !== parameterId || (prior.previous_revision ?? 0) !== revision || prior.saved_by !== identity.user_id || prior.operation !== operation) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadTestParameter(client, identity, parameterId, { atRevision: prior.revision });
}

export async function saveTestParameter(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = testParameterInput(value);
  const prior = await priorSave(client, identity, input.id, input.revision, input.requestId, input.revision ? 'update' : 'create');
  if (prior) {
    if (JSON.stringify(authoredFields(prior)) !== JSON.stringify(authoredFields(input))) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    return prior;
  }
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]);
  const current = (await client.query('SELECT revision,active,custom_field_count FROM test_parameters WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'parameter_not_found', 'Test parameter was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_parameter', 'The test parameter changed. Reload before saving.');
  const definitions = await parameterCustomFields(client, identity);
  const previousFields = current ? await loadParameterCustomFieldValues(client, identity, input.id, current.revision, current.custom_field_count) : [];
  const capture = await prepareParameterCustomFieldValues(client, identity, { definitions, entries: input.customFields,
    timeZone: input.customFieldTimeZone, previousFields });
  if (input.laboratoryId) {
    await client.query("SELECT laboratory_lock_references('laboratories',$1::uuid[])", [[input.laboratoryId]]);
    if (!(await client.query('SELECT id FROM laboratories WHERE organization_id=$1 AND id=$2 AND active', [identity.organization_id, input.laboratoryId])).rowCount) throw new HttpError(400, 'invalid_laboratory', 'Select an available lab.');
  }
  const args = [identity.organization_id, input.id, input.name, input.description, input.key, input.schemeAbbreviation, input.order, input.laboratoryId, input.measurementUncertainty !== null, input.requestId,
    capture.count, capture.provided];
  try {
    if (!input.revision) await client.query(`INSERT INTO test_parameters(organization_id,id,name,description,master_key,scheme_abbreviation,display_order,laboratory_id,uncertainty_configured,save_request_id,code,custom_field_count,custom_fields_provided)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$5,$11,$12)`, args);
    else await client.query(`UPDATE test_parameters SET name=$3,description=$4,master_key=$5,scheme_abbreviation=$6,display_order=$7,laboratory_id=$8,
      uncertainty_configured=$9,save_request_id=$10,custom_field_count=$11,custom_fields_provided=$12,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
    await appendParameterCustomFieldValues(client, identity, input.id, input.revision + 1, capture);
    await appendGrid(client, identity.organization_id, input.id, input.revision + 1, input.measurementUncertainty);
    await client.query('SET CONSTRAINTS parameter_custom_fields_complete IMMEDIATE');
    await client.query('SET CONSTRAINTS parameter_custom_fields_complete DEFERRED');
  } catch (error) {
    if (error.constraint === 'parameter_custom_field_unique') throw new HttpError(409, 'duplicate_parameter_custom_field', 'A unique Custom Field value is already in use.');
    if (error.constraint === 'parameter_custom_field_definition_set') throw new HttpError(409, 'parameter_custom_fields_changed', 'Custom Fields changed. Reload before saving.');
    if (error.constraint === 'parameter_custom_field_required') throw new HttpError(400, 'invalid_custom_field_value', 'Complete the required Custom Fields.');
    if (['parameter_custom_value_option', 'parameter_custom_value_option_fk', 'parameter_custom_value_user', 'parameter_custom_value_user_fk',
      'parameter_custom_value_attachment', 'parameter_custom_value_attachment_fk'].includes(error.constraint)) {
      throw new HttpError(400, 'invalid_parameter_custom_field_reference', 'A Custom Field selection is no longer available.');
    }
    if (error.constraint === 'test_parameter_save_request_key') throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
    if (error.code === '23505') throw new HttpError(409, 'duplicate_parameter', 'The parameter key or scheme abbreviation is already in use.');
    throw error;
  }
  return loadTestParameter(client, identity, input.id);
}

export async function retireTestParameter(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['id', 'revision', 'requestId']);
  const id = uuid(input.id, 'Parameter').toLowerCase(); const requestId = uuid(input.requestId, 'Delete request').toLowerCase();
  const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  const prior = await priorSave(client, identity, id, revision, requestId, 'retire');
  if (prior) return { id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM test_parameters WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'parameter_not_found', 'Test parameter was not found.');
  if (current.revision !== revision) throw new HttpError(409, 'stale_parameter', 'The test parameter changed. Reload before deleting.');
  const previous = await loadTestParameter(client, identity, id);
  await client.query('UPDATE test_parameters SET active=false,custom_fields_provided=false,revision=revision+1,updated_at=transaction_timestamp(),save_request_id=$3 WHERE organization_id=$1 AND id=$2', [identity.organization_id, id, requestId]);
  await appendGrid(client, identity.organization_id, id, revision + 1, previous.measurementUncertainty);
  return { id, revision: revision + 1 };
}

const listColumns = { scheme_abbr: 'parameter.scheme_abbreviation', name: 'parameter.name', lab_id: 'lab.name', key: 'parameter.master_key', order: 'parameter.display_order' };
const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const columnSearch = (value) => literalSearch(value).replace(/\s+/g, '%');
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

export async function listTestParameters(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search');
  const args = [identity.organization_id]; const conditions = ['parameter.organization_id=$1', 'parameter.active'];
  const customFields = await parameterCustomFields(client, identity, { forListing: true });
  const customColumns = new Map(customFields.map((field) => [customFieldColumnKey(field), field]));
  const bind = (value) => { args.push(value); return `$${args.length}`; };
  if (search) {
    const match = bind(literalSearch(search));
    const searchableFields = customFields.filter((field) => field.showInFilter);
    const customMatch = searchableFields.length ? ` OR ${parameterCustomFieldMatch(bind, searchableFields.map((field) => field.id), search)}` : '';
    conditions.push(`(${Object.entries(listColumns).filter(([key]) => key !== 'order').map(([, column]) => `${column} ILIKE ${match}`).join(' OR ')}${customMatch})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, [...Object.keys(listColumns), ...customFields.filter((field) => field.showInFilter).map(customFieldColumnKey)]);
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, ['type', 'value']);
    if (customColumns.has(key)) {
      const field = customColumns.get(key);
      const expectedType = field.fieldType === 'select' && field.options.length ? 'select' : 'text';
      if (filter.type !== expectedType) throw new HttpError(400, 'invalid_filter', 'Custom Field filters require the configured control type.');
      const value = searchText(filter.value, 'Custom Field filter');
      if (value) conditions.push(parameterCustomFieldMatch(bind, [field.id], value));
      continue;
    }
    if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Parameter filters require text.');
    const value = searchText(filter.value, 'Filter');
    if (value) conditions.push(`${listColumns[key]}::text ILIKE ${bind(columnSearch(value))}`);
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if ((!Object.hasOwn(listColumns, sort.key) && !customColumns.get(sort.key)?.showInList) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const customSort = customColumns.get(sort?.key);
  const order = customSort ? `CASE ordering_field.display_kind WHEN 'number' THEN 1 WHEN 'text' THEN 2 WHEN 'boolean' THEN 3 ELSE 0 END ${sort.dir},
    ordering_field.display_number ${sort.dir},ordering_field.display_text COLLATE "C" ${sort.dir},ordering_field.display_boolean ${sort.dir}`
    : sort ? `${listColumns[sort.key]} ${sort.dir} NULLS LAST` : 'parameter.created_at DESC';
  const from = `FROM test_parameters parameter LEFT JOIN laboratories lab ON lab.organization_id=parameter.organization_id AND lab.id=parameter.laboratory_id
    ${customSort ? `LEFT JOIN parameter_version_custom_fields ordering_field ON ordering_field.organization_id=parameter.organization_id
      AND ordering_field.parameter_id=parameter.id AND ordering_field.revision=parameter.revision AND ordering_field.field_id=${bind(customSort.id)}` : ''}
    WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT parameter.id AS _id,parameter.revision,parameter.scheme_abbreviation AS scheme_abbr,
    parameter.name,lab.name AS lab_id,parameter.master_key AS key,parameter.display_order AS "order" ${from}
    ORDER BY ${order},parameter.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows: await loadParameterListingValues(client, identity, rows, customFields), totalCount };
}

export async function parameterLaboratories(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Lab search');
  const rows = (await client.query(`SELECT id,name FROM laboratories WHERE organization_id=$1 AND active
    AND name ILIKE $2 ORDER BY name,id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}
