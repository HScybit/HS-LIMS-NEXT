import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';

export function requireNablRead(identity) {
  if (!identity.permission_codes?.some(code => ['compliance.read', 'compliance.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view NABL certifications.');
}
const id = (value, label) => uuid(value, label).toLowerCase();
function selection(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new HttpError(400, 'invalid_input', `${label} must contain at most ${maximum} selections.`);
  const ids = value.map(item => id(item, label));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_input', `${label} contains duplicate selections.`);
  return ids;
}
export function nablCertificationInput(input) {
  fieldsOnly(input, ['id', 'revision', 'requestId', 'validFrom', 'validTo', 'scopeFileId', 'certificateFileId', 'scopes']);
  const validFrom = dateOnly(input.validFrom); const validTo = dateOnly(input.validTo);
  if (validTo < validFrom) throw new HttpError(400, 'invalid_date_range', 'Valid To Date must be on or after Valid From Date.');
  if (!Array.isArray(input.scopes) || input.scopes.length > 2000) throw new HttpError(400, 'invalid_input', 'NABL scope must contain at most 2000 parameter rows.');
  const scopes = input.scopes.map(row => {
    fieldsOnly(row, ['parameterId', 'productIds', 'methodIds']);
    return { parameterId: id(row.parameterId, 'Parameter'), productIds: selection(row.productIds, 'Products', 500), methodIds: selection(row.methodIds, 'MoA', 500) };
  });
  if (new Set(scopes.map(row => row.parameterId)).size !== scopes.length) throw new HttpError(400, 'invalid_input', 'Each parameter can appear only once.');
  return { id: id(input.id, 'Certification'), revision: integer(input.revision, 'Revision', 0, 2_147_483_646), requestId: id(input.requestId, 'Save request'), validFrom, validTo,
    scopeFileId: input.scopeFileId == null || input.scopeFileId === '' ? null : id(input.scopeFileId, 'NABL Scope file'),
    certificateFileId: input.certificateFileId == null || input.certificateFileId === '' ? null : id(input.certificateFileId, 'NABL Certificate file'), scopes };
}
const file = (row, prefix) => row[`${prefix}_file_id`] ? { id: row[`${prefix}_file_id`], originalName: row[`${prefix}_file_name`], mediaType: row[`${prefix}_file_type`],
  byteLength: row[`${prefix}_file_length`], sha256: row[`${prefix}_file_sha256`], url: `/api/operations/nabl-certifications/files/${row[`${prefix}_file_id`]}` } : null;
export async function loadNablCertification(client, identity, certificationId, { atRevision, forEdit = false } = {}) {
  requireNablRead(identity); const certification = id(certificationId, 'Certification');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  if (typeof forEdit !== 'boolean' || forEdit && atRevision !== undefined) throw new HttpError(400, 'invalid_input', 'Edit the current certification revision.');
  const args = [identity.organization_id, certification]; if (atRevision !== undefined) args.push(atRevision);
  const row = (await client.query(`SELECT certification_id AS id,revision,previous_revision AS "previousRevision",request_id AS "requestId",operation,active,
    to_char(valid_from,'YYYY-MM-DD') AS "validFrom",to_char(valid_to,'YYYY-MM-DD') AS "validTo",scope_count AS "scopeCount",
    scope_file_id,scope_file_name,scope_file_type,scope_file_length,scope_file_sha256,certificate_file_id,certificate_file_name,certificate_file_type,certificate_file_length,certificate_file_sha256,
    saved_by AS "savedBy",saved_by_username AS "savedByUsername",saved_by_name AS "savedByName",saved_at AS "savedAt"
    FROM ${atRevision === undefined ? 'nabl_certificate_directory' : 'nabl_certificate_history'}
    WHERE organization_id=$1 AND certification_id=$2 ${atRevision === undefined ? '' : 'AND revision=$3'}`, args)).rows[0];
  if (!row) throw new HttpError(404, 'nabl_not_found', 'NABL certification was not found.');
  const version = [identity.organization_id, certification, row.revision];
  const scopes = (await client.query(`SELECT item.parameter_id AS "parameterId",${forEdit ? 'reference.name' : 'item.parameter_name'} AS "parameterName",
    ${forEdit ? 'reference.scheme_abbreviation' : 'item.scheme_abbreviation'} AS "schemeAbbreviation",${forEdit ? 'reference.revision' : 'item.parameter_revision'} AS "parameterRevision"
    FROM nabl_scope_history item ${forEdit ? 'JOIN nabl_parameter_catalog reference ON reference.organization_id=item.organization_id AND reference.id=item.parameter_id' : ''}
    WHERE item.organization_id=$1 AND item.certification_id=$2 AND item.revision=$3 ORDER BY item.position`, version)).rows;
  const products = (await client.query(`SELECT item.parameter_id AS "parameterId",item.product_id AS id,${forEdit ? 'reference.name' : 'item.product_name'} AS name,${forEdit ? 'reference.revision' : 'item.product_revision'} AS revision
    FROM nabl_product_history item ${forEdit ? 'JOIN nabl_product_catalog reference ON reference.organization_id=item.organization_id AND reference.id=item.product_id' : ''}
    WHERE item.organization_id=$1 AND item.certification_id=$2 AND item.revision=$3 ORDER BY item.parameter_id,item.position`, version)).rows;
  const methods = (await client.query(`SELECT item.parameter_id AS "parameterId",item.method_id AS id,${forEdit ? 'reference.name' : 'item.method_name'} AS name,${forEdit ? 'reference.revision' : 'item.method_revision'} AS revision
    FROM nabl_method_history item ${forEdit ? 'JOIN nabl_method_catalog reference ON reference.organization_id=item.organization_id AND reference.id=item.method_id' : ''}
    WHERE item.organization_id=$1 AND item.certification_id=$2 AND item.revision=$3 ORDER BY item.parameter_id,item.position`, version)).rows;
  const byParameter = new Map(scopes.map(scope => [scope.parameterId, { ...scope, products: [], methods: [] }]));
  for (const { parameterId, ...product } of products) byParameter.get(parameterId).products.push(product);
  for (const { parameterId, ...method } of methods) byParameter.get(parameterId).methods.push(method);
  const result = { ...row, scopeFile: file(row, 'scope'), certificateFile: file(row, 'certificate'),
    scopes: [...byParameter.values()].map(scope => ({ ...scope, accredited: scope.products.length > 0 && scope.methods.length > 0 })) };
  for (const key of Object.keys(result)) if (key.includes('_file_')) delete result[key];
  return result;
}
async function writeCertification(client, identity, operation, input) {
  const productParameters = []; const products = []; const methodParameters = []; const methods = [];
  for (const scope of input.scopes ?? []) {
    for (const product of scope.productIds) { productParameters.push(scope.parameterId); products.push(product); }
    for (const method of scope.methodIds) { methodParameters.push(scope.parameterId); methods.push(method); }
  }
  const values = operation === 'retire' ? Array(9).fill(null) : [input.validFrom, input.validTo, input.scopeFileId, input.certificateFileId,
    input.scopes.map(scope => scope.parameterId), productParameters, products, methodParameters, methods];
  let revision;
  try { revision = (await client.query('SELECT nabl_write_certificate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS revision',
    [operation, input.id, input.revision, input.requestId, ...values])).rows[0].revision; }
  catch (error) {
    const errors = {
      nabl_invalid_input: [400, 'invalid_input', 'NABL certification details are invalid.'],
      nabl_request_reused: [409, 'save_request_reused', 'This save request was already used for another change.'],
      nabl_stale: [409, 'stale_nabl_certification', 'The certification changed. Reload before saving.'],
      nabl_not_found: [404, 'nabl_not_found', 'NABL certification was not found.'],
      nabl_invalid_reference: [422, 'invalid_reference', 'A selected parameter, product, method or file is unavailable.'],
      nabl_invalid_scope: [422, 'invalid_nabl_scope', 'Each selected product and MoA must have an active Decision Rule for its parameter.'],
      nabl_session_required: [403, 'forbidden', 'An active compliance management session is required.'],
    };
    throw errors[error.constraint] ? new HttpError(...errors[error.constraint]) : error;
  }
  return loadNablCertification(client, identity, input.id, { atRevision: revision });
}
export async function saveNablCertification(client, identity, input) {
  requirePermission(identity, 'compliance.manage'); return writeCertification(client, identity, 'save', nablCertificationInput(input));
}
export async function retireNablCertification(client, identity, input) {
  requirePermission(identity, 'compliance.manage'); fieldsOnly(input, ['id', 'revision', 'requestId']);
  return writeCertification(client, identity, 'retire', { id: id(input.id, 'Certification'), revision: integer(input.revision, 'Revision', 1, 2_147_483_646), requestId: id(input.requestId, 'Save request') });
}
const literal = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 500 || !value.isWellFormed() || value.includes('\0')) throw new HttpError(400, 'invalid_input', 'Search text is invalid.');
  return value.trim();
}
export async function listNablCertifications(client, identity, input = {}) {
  requireNablRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'sort', 'filters']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search); const args = [identity.organization_id]; let where = 'organization_id=$1';
  if (search) { args.push(literal(search)); where += " AND (certification_id::text ILIKE $2 OR to_char(valid_from,'YYYY-MM-DD') ILIKE $2 OR to_char(valid_to,'YYYY-MM-DD') ILIKE $2 OR scope_file_name ILIKE $2 OR certificate_file_name ILIKE $2)"; }
  const columns = { _id: 'certification_id', validFrom: 'valid_from', validTo: 'valid_to' }; let order = 'created_at DESC';
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    if (key === '_id') {
      fieldsOnly(filter, ['type', 'value']); if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'ID requires a text filter.');
      const value = searchText(filter.value); if (value) { args.push(literal(value)); where += ` AND certification_id::text ILIKE $${args.length}`; }
    } else {
      fieldsOnly(filter, ['type', 'from', 'to']); if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Validity requires calendar date filters.');
      for (const [bound, operator] of [['from', '>='], ['to', '<=']]) if (filter[bound] !== undefined && filter[bound] !== '') {
        args.push(dateOnly(filter[bound])); where += ` AND ${columns[key]}${operator}$${args.length}::date`;
      }
    }
  }
  if (input.sort) {
    fieldsOnly(input.sort, ['key', 'dir']); if (!Object.hasOwn(columns, input.sort.key) || !['asc', 'desc'].includes(input.sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
    order = `${columns[input.sort.key]} ${input.sort.dir}`;
  }
  const totalCount = Number((await client.query(`SELECT count(*) AS count FROM nabl_certificate_directory WHERE ${where}`, args)).rows[0].count);
  const rows = (await client.query(`SELECT certification_id AS _id,revision,to_char(valid_from,'YYYY-MM-DD') AS "validFrom",to_char(valid_to,'YYYY-MM-DD') AS "validTo",
    scope_file_name AS "scopeFileName",certificate_file_name AS "certificateFileName" FROM nabl_certificate_directory WHERE ${where}
    ORDER BY ${order},certification_id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}
export async function nablCatalog(client, identity, input = {}) {
  requireNablRead(identity); fieldsOnly(input, ['kind', 'parameterId', 'search', 'page', 'pageSize', 'selectedIds']);
  if (!['parameter', 'product', 'method'].includes(input.kind)) throw new HttpError(400, 'invalid_input', 'Choose a NABL reference type.');
  const selectedIds = selection(input.selectedIds ?? [], 'Retained references', input.kind === 'parameter' ? 2000 : 500);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 20, 'Page size', 1, 100);
  const search = searchText(input.search); const args = [identity.organization_id, selectedIds];
  let where = 'reference.organization_id=$1 AND (reference.active OR reference.id=ANY($2::uuid[]))';
  if (input.kind !== 'parameter') {
    args.push(id(input.parameterId, 'Parameter'));
    where += ` AND (reference.id=ANY($2::uuid[]) OR EXISTS (SELECT 1 FROM nabl_rule_catalog rule WHERE rule.organization_id=$1 AND rule.test_parameter_id=$3 AND rule.${input.kind}_id=reference.id))`;
  } else if (input.parameterId !== undefined) throw new HttpError(400, 'invalid_input', 'Parameter catalog does not take a selected parameter.');
  if (search) { args.push(literal(search)); where += ` AND (reference.name ILIKE $${args.length}${input.kind === 'parameter' ? ` OR reference.scheme_abbreviation ILIKE $${args.length}` : ''})`; }
  const table = `nabl_${input.kind}_catalog`;
  const totalCount = Number((await client.query(`SELECT count(*) AS count FROM ${table} reference WHERE ${where}`, args)).rows[0].count);
  const rows = (await client.query(`SELECT reference.id,reference.name,reference.revision,reference.active${input.kind === 'parameter' ? ',reference.scheme_abbreviation AS "schemeAbbreviation"' : ''}
    FROM ${table} reference WHERE ${where} ORDER BY ${input.kind === 'parameter' ? 'reference.display_order,' : ''}reference.name,reference.id
    LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}
