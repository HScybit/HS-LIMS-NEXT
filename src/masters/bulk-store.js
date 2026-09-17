import { randomUUID } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { allowedMasterBulkResources, masterBulkPageSize, masterBulkResources } from './bulk-config.js';
import { masterBulkResource } from './bulk-row.js';
import { prepareUserBulkCredential } from '../users/bulk-credentials.js';
import { loadUserBulkCredentialStates, storeUserBulkCredentials } from '../users/bulk-store.js';
import { requireMasterBulkAccess } from './bulk-access.js';

const invalid = message => new HttpError(400, 'invalid_bulk_input', message);
const conflict = () => new HttpError(409, 'bulk_request_reused', 'This request was already used for different upload data.');
const idValue = (value, label) => uuid(value, label).toLowerCase();
const sourceKeys = ['type', 'formula', 'hasResult', 'errorCode', 'hyperlink', 'numberFormat'];
const requireBulkManager = identity => {
  if (!allowedMasterBulkResources(identity.permission_codes).length) requirePermission(identity, 'masters.manage');
};
const publicBatch = batch => { const result = { ...batch }; delete result.sourceHmacSha256; return result; };

function cellInput(value, metadata) {
  let kind = value === undefined ? 'missing' : value instanceof Date ? 'date' : typeof value;
  if (kind === 'string') kind = 'text';
  if (!['missing', 'text', 'number', 'boolean', 'date'].includes(kind)
    || kind === 'text' && (value.length > 16000 || !value.isWellFormed() || value.includes('\0'))
    || kind === 'number' && !Number.isFinite(value) || kind === 'date' && !Number.isFinite(value.valueOf())) throw invalid('A cell has an unsupported value.');
  const source = metadata ?? {};
  for (const key of sourceKeys) {
    if (source[key] == null) continue;
    if (key === 'hasResult' ? typeof source[key] !== 'boolean'
      : typeof source[key] !== 'string' || source[key].length > 16000 || !source[key].isWellFormed() || source[key].includes('\0')) throw invalid('A cell has invalid source metadata.');
  }
  if (source.type && !['formula', 'error', 'hyperlink', 'rich_text', 'formatted', 'date'].includes(source.type)) throw invalid('A cell has unsupported source metadata.');
  return [kind, kind === 'text' ? value : null, kind === 'number' ? value : null, kind === 'boolean' ? value : null,
    kind === 'date' ? value.toISOString() : null, ...sourceKeys.map(key => source[key] ?? null)];
}

const batchSelect = `SELECT id,resource,file_name AS "fileName",file_format AS format,source_sha256 AS "sourceSha256",source_hmac_sha256 AS "sourceHmacSha256",time_zone AS "timeZone",
  header_row_number AS "headerRowNumber",sheet_name AS "sheetName",sheet_count AS "sheetCount",date_1904 AS "date1904",
  column_count AS "columnCount",row_count AS "rowCount",saved_by AS "savedBy",saved_at AS "savedAt",
  EXISTS (SELECT 1 FROM custom_field_definitions field WHERE field.organization_id=master_bulk_batches.organization_id AND field.active
    AND field.associated_with=CASE master_bulk_batches.resource WHEN 'products' THEN 'product' WHEN 'test-parameters' THEN 'parameter' WHEN 'methods' THEN 'method_of_analysis' WHEN 'customers' THEN 'customer' WHEN 'vendors' THEN 'vendor' END
    AND field.field_type IN ('date','date_time')) AS "hasDateFields" FROM master_bulk_batches`;

export async function loadMasterBulkBatch(client, identity, batchId) {
  requireBulkManager(identity); const id = idValue(batchId, 'Upload');
  const batch = (await client.query(`${batchSelect} WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!batch) throw new HttpError(404, 'bulk_not_found', 'Bulk upload was not found.');
  await requireMasterBulkAccess(client, identity, batch.resource);
  const columns = (await client.query(`SELECT column_number AS "columnNumber",source_header AS header,source_type AS type,formula,has_result AS "hasResult",
    error_code AS "errorCode",hyperlink,number_format AS "numberFormat" FROM master_bulk_columns WHERE organization_id=$1 AND batch_id=$2 ORDER BY column_number`, [identity.organization_id, id])).rows;
  return { ...batch, columns };
}

async function insertCells(client, organizationId, batchId, rows, columnCount) {
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    if (pending.every(cell => cell[3] === 'text' && cell.slice(5).every(value => value === null))) {
      await client.query(`INSERT INTO master_bulk_cells(organization_id,batch_id,row_id,revision,column_number,value_kind,text_value)
        SELECT $1,$2,row_id,revision,column_number,'text',text_value FROM unnest($3::uuid[],$4::integer[],$5::integer[],$6::text[])
        AS cells(row_id,revision,column_number,text_value)`, [organizationId, batchId, ...[0, 1, 2, 4].map(index => pending.map(cell => cell[index]))]);
    } else {
      const arrays = Array.from({ length: 14 }, (_, index) => pending.map(cell => cell[index]));
      await client.query(`INSERT INTO master_bulk_cells(organization_id,batch_id,row_id,revision,column_number,value_kind,text_value,number_value,boolean_value,date_value,
      source_type,formula,has_result,error_code,hyperlink,number_format)
      SELECT $1,$2,row_id,revision,column_number,value_kind,text_value,number_value,boolean_value,date_value,source_type,formula,has_result,error_code,hyperlink,number_format
      FROM unnest($3::uuid[],$4::integer[],$5::integer[],$6::text[],$7::text[],$8::double precision[],$9::boolean[],$10::timestamptz[],
        $11::text[],$12::text[],$13::boolean[],$14::text[],$15::text[],$16::text[])
      AS cells(row_id,revision,column_number,value_kind,text_value,number_value,boolean_value,date_value,source_type,formula,has_result,error_code,hyperlink,number_format)`,
      [organizationId, batchId, ...arrays]);
    }
    pending = [];
  };
  for (const row of rows) {
    const metadata = new Map((row.cellMetadata ?? []).map(cell => [cell.columnNumber, cell]));
    for (let index = 0; index < columnCount; index++) {
      pending.push([row.id, row.revision, index + 1, ...cellInput(row.values[index], metadata.get(index + 1))]);
      if (pending.length === 5000) await flush();
    }
  }
  await flush();
}

function uploadMetadata(identity, input) {
  requireBulkManager(identity);
  fieldsOnly(input, ['id', 'resource', 'fileName', 'format', 'sourceSha256', 'sourceHmacSha256', 'timeZone']);
  const id = idValue(input.id, 'Upload'); requirePermission(identity, masterBulkResource(input.resource).permission);
  const name = text(input.fileName, 'File name', 250); const zone = customFieldTimeZone(input.timeZone);
  const user = input.resource === 'users';
  if (name.includes('\0') || !name.isWellFormed() || !['csv', 'xlsx'].includes(input.format)
    || !/^[a-f0-9]{64}$/.test(user ? input.sourceHmacSha256 : input.sourceSha256)
    || Object.hasOwn(input, user ? 'sourceSha256' : 'sourceHmacSha256')) throw invalid('Upload file metadata is invalid.');
  return { id, resource: input.resource, fileName: name, format: input.format, timeZone: zone,
    sourceSha256: user ? null : input.sourceSha256, sourceHmacSha256: user ? input.sourceHmacSha256 : null };
}

async function priorUpload(client, identity, metadata) {
  const prior = (await client.query(`${batchSelect} WHERE organization_id=$1 AND id=$2`, [identity.organization_id, metadata.id])).rows[0];
  if (prior) {
    if (['resource', 'sourceSha256', 'sourceHmacSha256', 'fileName', 'format', 'timeZone'].some(key => prior[key] !== metadata[key])
      || prior.savedBy !== identity.user_id) throw conflict();
    return { id: metadata.id, rowCount: prior.rowCount };
  }
  return null;
}

export async function findMasterBulkUpload(client, identity, input) {
  const metadata = uploadMetadata(identity, input);
  await requireMasterBulkAccess(client, identity, metadata.resource);
  return priorUpload(client, identity, metadata);
}

export async function stageMasterBulk(client, identity, input, decoded, { credentials } = {}) {
  const metadata = uploadMetadata(identity, input); const { id, fileName: name, timeZone: zone } = metadata;
  await requireMasterBulkAccess(client, identity, metadata.resource, { write: true });
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('master-bulk:'||$1::text||':'||$2::text,0))", [identity.organization_id, id]);
  const prior = await priorUpload(client, identity, metadata); if (prior) return prior;
  if (input.resource !== 'users' && credentials !== undefined) throw invalid('Credentials belong to User uploads only.');
  if (!decoded || !Array.isArray(decoded.rows) || decoded.rows.length < 1 || decoded.rows.length > 2500
    || !Array.isArray(decoded.sourceHeaders) || decoded.sourceHeaders.length < 1 || decoded.sourceHeaders.length > 250) throw invalid('Upload shape is invalid.');
  const columns = [...decoded.sourceHeaders];
  // CSV permits extra unheaded cells only when they are blank. Keep their source positions.
  const width = Math.max(columns.length, ...decoded.rows.map(row => Array.isArray(row.values) ? row.values.length : 0));
  if (width > 250) throw invalid('Upload shape is invalid.');
  while (columns.length < width) columns.push('');
  const headerMetadata = new Map((decoded.headerCellMetadata ?? []).map(cell => [cell.columnNumber, cell]));
  const headerRow = integer(decoded.headerRowNumber, 'Header row', 1, 2_147_483_647);
  const rows = decoded.rows.map((row, index) => ({ ...row, rowNumber: integer(row.rowNumber, 'Source row', headerRow + 1, 2_147_483_647),
    id: randomUUID(), requestId: randomUUID(), revision: 1, ordinal: index + 1 }));
  if (new Set(rows.map(row => row.rowNumber)).size !== rows.length || rows.some(row => !Array.isArray(row.values) || row.values.length > columns.length)) throw invalid('Source rows are invalid.');
  await client.query(`INSERT INTO master_bulk_batches(organization_id,id,resource,file_name,file_format,source_sha256,source_hmac_sha256,time_zone,header_row_number,sheet_name,sheet_count,date_1904,column_count,row_count,saved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [identity.organization_id, id, input.resource, name, input.format, metadata.sourceSha256, metadata.sourceHmacSha256, zone,
    headerRow, input.format === 'xlsx' ? decoded.sheetName : null, input.format === 'xlsx' ? decoded.sheetCount : null,
    input.format === 'xlsx' ? decoded.date1904 : null, columns.length, rows.length, identity.user_id]);
  const sourceColumns = columns.map((header, index) => {
    if (typeof header !== 'string') throw invalid('Header cells must contain text.');
    return [index + 1, header, ...cellInput(header, headerMetadata.get(index + 1)).slice(5)];
  });
  await client.query(`INSERT INTO master_bulk_columns(organization_id,batch_id,column_number,source_header,source_type,formula,has_result,error_code,hyperlink,number_format)
    SELECT $1,$2,column_number,source_header,source_type,formula,has_result,error_code,hyperlink,number_format
    FROM unnest($3::integer[],$4::text[],$5::text[],$6::text[],$7::boolean[],$8::text[],$9::text[],$10::text[])
    AS columns(column_number,source_header,source_type,formula,has_result,error_code,hyperlink,number_format)`,
  [identity.organization_id, id, ...Array.from({ length: 8 }, (_, index) => sourceColumns.map(column => column[index]))]);
  await client.query(`INSERT INTO master_bulk_rows(organization_id,batch_id,id,ordinal,source_row_number)
    SELECT $1,$2,id,ordinal,row_number FROM unnest($3::uuid[],$4::integer[],$5::integer[]) AS rows(id,ordinal,row_number)`,
  [identity.organization_id, id, rows.map(row => row.id), rows.map(row => row.ordinal), rows.map(row => row.rowNumber)]);
  await client.query(`INSERT INTO master_bulk_row_versions(organization_id,batch_id,row_id,revision,request_id,saved_by)
    SELECT $1,$2,id,1,request_id,$5 FROM unnest($3::uuid[],$4::uuid[]) AS rows(id,request_id)`,
  [identity.organization_id, id, rows.map(row => row.id), rows.map(row => row.requestId), identity.user_id]);
  await insertCells(client, identity.organization_id, id, rows, columns.length);
  if (input.resource === 'users') await storeUserBulkCredentials(client, identity, id, rows, credentials);
  return { id, rowCount: rows.length };
}

const rowStatus = `SELECT row.id,row.ordinal,row.source_row_number AS "rowNumber",row.revision,
  review.id AS "reviewId",review.valid,review.operation,review.error_code AS "validationCode",review.error_message AS "validationMessage",
  review.candidate_id AS "candidateId",review.expected_revision AS "expectedRevision",review.definitions_sha256 AS "definitionsSha256",
  attempt.id AS "attemptId",attempt.committed,attempt.error_code AS "processingCode",attempt.error_message AS "processingMessage",
  attempt.result_revision AS "resultRevision",coalesce(attempt.product_id,attempt.parameter_id,attempt.method_id,attempt.user_id,attempt.customer_id,attempt.vendor_id) AS "resultId"
  FROM master_bulk_rows row
  LEFT JOIN LATERAL (SELECT * FROM master_bulk_reviews WHERE organization_id=row.organization_id AND batch_id=row.batch_id AND row_id=row.id
    AND input_revision=row.revision ORDER BY sequence DESC LIMIT 1) review ON true
  LEFT JOIN LATERAL (SELECT * FROM master_bulk_attempts WHERE organization_id=row.organization_id AND batch_id=row.batch_id AND row_id=row.id
    AND input_revision=row.revision AND (committed OR review_id=review.id) ORDER BY sequence DESC LIMIT 1) attempt ON true`;

export async function masterBulkRowStatus(client, identity, batchId) {
  return (await client.query(`${rowStatus} WHERE row.organization_id=$1 AND row.batch_id=$2 ORDER BY row.ordinal`, [identity.organization_id, batchId])).rows;
}

export async function loadMasterBulkCells(client, identity, batchId, rows, { original = false } = {}) {
  if (!rows.length) return [];
  const cells = (await client.query(`SELECT cell.row_id AS "rowId",cell.column_number AS "columnNumber",cell.value_kind AS kind,
    cell.text_value AS "textValue",cell.number_value AS "numberValue",cell.boolean_value AS "booleanValue",cell.date_value AS "dateValue",
    cell.source_type AS type,cell.formula,cell.has_result AS "hasResult",cell.error_code AS "errorCode",cell.hyperlink,cell.number_format AS "numberFormat"
    FROM master_bulk_cells cell JOIN unnest($3::uuid[],$4::integer[]) AS requested(id,revision) ON requested.id=cell.row_id AND requested.revision=cell.revision
    WHERE cell.organization_id=$1 AND cell.batch_id=$2 ORDER BY cell.row_id,cell.column_number`,
  [identity.organization_id, batchId, rows.map(row => row.id), rows.map(row => original ? 1 : row.revision)])).rows;
  const byId = new Map(rows.map(row => [row.id, { ...row, values: [], cellMetadata: [] }]));
  for (const cell of cells) {
    const row = byId.get(cell.rowId);
    row.values[cell.columnNumber - 1] = cell.kind === 'missing' ? undefined : cell[`${cell.kind}Value`];
    if (cell.type || cell.numberFormat) row.cellMetadata.push(Object.fromEntries([['columnNumber', cell.columnNumber],
      ...sourceKeys.filter(key => cell[key] !== null).map(key => [key, cell[key]])]));
  }
  return [...byId.values()];
}

export function masterBulkSummary(rows) {
  return { total: rows.length, committed: rows.filter(row => row.committed).length,
    ready: rows.filter(row => !row.committed && row.valid && !row.processingCode).length,
    rejected: rows.filter(row => !row.committed && (row.valid === false || row.processingCode)).length,
    unvalidated: rows.filter(row => !row.committed && row.valid == null).length,
    updates: rows.filter(row => !row.committed && row.valid && !row.processingCode && row.operation !== 'create').length };
}

export async function loadMasterBulkPreview(client, identity, batchId, input = {}) {
  fieldsOnly(input, ['page', 'status']); const requestedPage = integer(input.page ?? 1, 'Page', 1, 50);
  const filter = input.status ?? 'all';
  if (!['all', 'rejected'].includes(filter)) throw invalid('Select all rows or blocked rows.');
  const batch = await loadMasterBulkBatch(client, identity, batchId);
  const status = await masterBulkRowStatus(client, identity, batch.id);
  const filtered = filter === 'rejected' ? status.filter(row => !row.committed && (row.valid === false || row.processingCode)) : status;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(filtered.length / masterBulkPageSize)));
  const rows = await loadMasterBulkCells(client, identity, batch.id, filtered.slice((page - 1) * masterBulkPageSize, page * masterBulkPageSize));
  if (batch.resource === 'users') {
    const credentials = await loadUserBulkCredentialStates(client, identity, batch.id, rows);
    if (credentials.size !== rows.length) throw new HttpError(403, 'forbidden', 'User upload credentials are unavailable. Reload your session.');
    for (const row of rows) row.passwordState = credentials.get(row.id).state;
  }
  const fileErrors = [...new Set(status.filter(row => !row.committed && ['invalid_bulk_columns', 'missing_bulk_columns', 'invalid_bulk_definitions'].includes(row.validationCode)).map(row => row.validationMessage))];
  return { batch: publicBatch(batch), summary: masterBulkSummary(status), rows, page, pageSize: masterBulkPageSize, filteredTotal: filtered.length, fileErrors,
    // Bounded identifiers allow chunked validation/processing without downloading all cell data.
    rowStates: status.map(({ id, revision, reviewId, valid, committed, processingCode }) => ({ id, revision, reviewId, valid, committed, rejected: valid === false || Boolean(processingCode) })) };
}

export async function listMasterBulk(client, identity, resource, input = {}) {
  requireBulkManager(identity);
  if (resource !== 'all') await requireMasterBulkAccess(client, identity, resource);
  fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000);
  const pageSize = integer(input.pageSize ?? 50, 'Page size', 1, 100);
  const args = [identity.organization_id]; const conditions = ['organization_id=$1'];
  const bind = value => { args.push(value); return `$${args.length}`; };
  const queryText = value => {
    const result = text(value, 'Search', 500, { optional: true }).trim();
    if (!result.isWellFormed() || result.includes('\0')) throw invalid('Search text is invalid.');
    return result;
  };
  const literal = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
  const modelLabel = `CASE resource ${Object.entries(masterBulkResources).map(([key, config]) => `WHEN ${bind(key)} THEN ${bind(config.label)}::text`).join(' ')} END`;
  if (resource !== 'all') conditions.push(`resource=${bind(resource)}`);
  const search = queryText(input.search);
  if (search) { const match = bind(literal(search)); conditions.push(`(file_name ILIKE ${match} OR ${modelLabel} ILIKE ${match})`); }
  const filters = input.filters ?? {}; fieldsOnly(filters, ['resource', 'fileName', 'savedAt']);
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, key === 'savedAt' ? ['type', 'from', 'to'] : ['type', 'value']);
    if (key === 'savedAt') {
      if (filter.type !== 'date') throw invalid('Upload date filters require calendar dates.');
      const from = filter.from ? dateOnly(filter.from) : null; const to = filter.to ? dateOnly(filter.to) : null;
      if (from && to && from > to) throw invalid('The upload date range is reversed.');
      if (from) conditions.push(`saved_at>=(${bind(from)}::date::timestamp AT TIME ZONE 'UTC')`);
      if (to) conditions.push(`saved_at<((${bind(to)}::date+1)::timestamp AT TIME ZONE 'UTC')`);
    } else if (key === 'resource') {
      if (filter.type !== 'select') throw invalid('Select an upload model.');
      const value = queryText(filter.value); if (value) { await requireMasterBulkAccess(client, identity, value); conditions.push(`resource=${bind(value)}`); }
    } else {
      if (filter.type !== 'text') throw invalid('File name filters require text.');
      const value = queryText(filter.value); if (value) conditions.push(`file_name ILIKE ${bind(literal(value).replace(/\s+/g, '%'))}`);
    }
  }
  const columns = { resource: modelLabel, fileName: 'file_name', savedAt: 'saved_at' }; const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw invalid('Upload sort is invalid.');
  }
  // Bind model labels once even when this query does not sort or search by them.
  const from = `FROM master_bulk_batches WHERE ${conditions.join(' AND ')} AND ${modelLabel} IS NOT NULL`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const visible = (await client.query(`${batchSelect} ${from.slice('FROM master_bulk_batches '.length)} ORDER BY ${sort ? `${columns[sort.key]} ${sort.dir}` : 'saved_at DESC'},id
    LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  const counts = visible.length ? (await client.query(`SELECT row.batch_id AS id,
    count(*) FILTER (WHERE attempt.committed)::integer AS committed,
    count(*) FILTER (WHERE NOT coalesce(attempt.committed,false) AND (review.valid=false OR attempt.error_code IS NOT NULL))::integer AS rejected,
    count(*) FILTER (WHERE NOT coalesce(attempt.committed,false) AND review.valid AND review.operation<>'create')::integer AS updates,
    count(*) FILTER (WHERE review.id IS NULL)::integer AS unvalidated
    FROM master_bulk_rows row
    LEFT JOIN LATERAL (SELECT id,valid,operation FROM master_bulk_reviews WHERE organization_id=row.organization_id AND batch_id=row.batch_id AND row_id=row.id
      AND input_revision=row.revision ORDER BY sequence DESC LIMIT 1) review ON true
    LEFT JOIN LATERAL (SELECT committed,error_code FROM master_bulk_attempts WHERE organization_id=row.organization_id AND batch_id=row.batch_id AND row_id=row.id
      AND input_revision=row.revision AND (committed OR review_id=review.id) ORDER BY sequence DESC LIMIT 1) attempt ON true
    WHERE row.organization_id=$1 AND row.batch_id=ANY($2::uuid[]) GROUP BY row.batch_id`, [identity.organization_id, visible.map(row => row.id)])).rows : [];
  const byId = new Map(counts.map(row => [row.id, row]));
  return { rows: visible.map(row => ({ ...publicBatch(row), _id: row.id, ...byId.get(row.id) })), totalCount, hasMore: page * pageSize < totalCount, page };
}

export async function correctMasterBulkRow(client, identity, batchId, input) {
  const batch = await loadMasterBulkBatch(client, identity, batchId);
  await requireMasterBulkAccess(client, identity, batch.resource, { write: true });
  fieldsOnly(input, ['id', 'revision', 'requestId', 'cells']);
  const id = idValue(input.id, 'Row'); const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  const requestId = idValue(input.requestId, 'Correction request');
  if (!Array.isArray(input.cells) || !input.cells.length || input.cells.length > batch.columnCount) throw invalid('Provide the cells to correct.');
  const fixes = new Map();
  for (const cell of input.cells) {
    fieldsOnly(cell, ['columnNumber', 'value']); const column = integer(cell.columnNumber, 'Column', 1, batch.columnCount);
    if (!Object.hasOwn(cell, 'value') || fixes.has(column)) throw invalid('Provide each corrected cell once.');
    cellInput(cell.value); fixes.set(column, cell.value);
  }
  const passwordColumn = batch.resource === 'users' ? batch.columns.find(column => column.header.trim() === 'password')?.columnNumber : null;
  let credential;
  if (passwordColumn && fixes.has(passwordColumn)) {
    credential = await prepareUserBulkCredential(fixes.get(passwordColumn));
    fixes.set(passwordColumn, '');
  }
  // Serialize corrections across a batch to enforce the aggregate current-input limit.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('master-bulk:'||$1::text||':'||$2::text,0))", [identity.organization_id, batch.id]);
  const current = (await client.query('SELECT id,revision FROM master_bulk_rows WHERE organization_id=$1 AND batch_id=$2 AND id=$3 FOR UPDATE', [identity.organization_id, batch.id, id])).rows[0];
  if (!current) throw new HttpError(404, 'bulk_row_not_found', 'Upload row was not found.');
  const prior = (await client.query('SELECT batch_id,row_id,revision,saved_by FROM master_bulk_row_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (prior) {
    if (prior.batch_id !== batch.id || prior.row_id !== id || prior.revision !== revision + 1 || prior.saved_by !== identity.user_id) throw conflict();
    const [saved] = await loadMasterBulkCells(client, identity, batch.id, [{ id, revision: prior.revision }]);
    const [before] = await loadMasterBulkCells(client, identity, batch.id, [{ id, revision }]);
    for (const [column, value] of fixes) before.values[column - 1] = value;
    if (JSON.stringify(before.values) !== JSON.stringify(saved.values)
      || saved.cellMetadata.some(cell => fixes.has(cell.columnNumber))) throw conflict();
    if (batch.resource === 'users') {
      const savedCredential = (await loadUserBulkCredentialStates(client, identity, batch.id, [{ id, revision: prior.revision }])).get(id);
      const expectedCredential = credential ?? (await loadUserBulkCredentialStates(client, identity, batch.id, [{ id, revision }])).get(id);
      if (!savedCredential || !expectedCredential || savedCredential.fingerprint !== expectedCredential.fingerprint) throw conflict();
    }
    return { id, revision: prior.revision };
  }
  if (current.revision !== revision) throw new HttpError(409, 'stale_bulk_input', 'This row changed. Reload before correcting it.');
  if ((await client.query('SELECT 1 FROM master_bulk_attempts WHERE organization_id=$1 AND batch_id=$2 AND row_id=$3 AND committed', [identity.organization_id, batch.id, id])).rowCount) throw new HttpError(409, 'bulk_row_committed', 'This row was already committed and cannot be corrected.');
  const [row] = await loadMasterBulkCells(client, identity, batch.id, [current]);
  for (const [column, value] of fixes) row.values[column - 1] = value;
  row.cellMetadata = row.cellMetadata.filter(cell => !fixes.has(cell.columnNumber)); row.revision++;
  const changedValues = [...fixes.values()].map(value => cellInput(value));
  // Count unchanged and proposed cells with the same PostgreSQL representation,
  // including its number/date formatting, rather than subtracting JS display text.
  const total = (await client.query(`SELECT coalesce(sum(octet_length(coalesce(cell.text_value,cell.number_value::text,cell.boolean_value::text,cell.date_value::text,''))),0)::double precision AS bytes
    FROM master_bulk_cells cell JOIN master_bulk_rows row ON row.organization_id=cell.organization_id AND row.batch_id=cell.batch_id AND row.id=cell.row_id AND row.revision=cell.revision
    WHERE cell.organization_id=$1 AND cell.batch_id=$2 AND NOT (cell.row_id=$3 AND cell.column_number=ANY($4::integer[]))`,
  [identity.organization_id, batch.id, id, [...fixes.keys()]])).rows[0].bytes;
  const proposed = (await client.query(`SELECT coalesce(sum(octet_length(coalesce(text_value,number_value::text,boolean_value::text,date_value::text,''))),0)::double precision AS bytes
    FROM unnest($1::text[],$2::double precision[],$3::boolean[],$4::timestamptz[]) AS proposed(text_value,number_value,boolean_value,date_value)`,
  [1, 2, 3, 4].map(index => changedValues.map(value => value[index])))).rows[0].bytes;
  if (total + proposed > 16 * 1_048_576) throw new HttpError(413, 'bulk_input_limit', 'Current upload values must not exceed 16 MiB.');
  await client.query('UPDATE master_bulk_rows SET revision=revision+1 WHERE organization_id=$1 AND batch_id=$2 AND id=$3', [identity.organization_id, batch.id, id]);
  await client.query('INSERT INTO master_bulk_row_versions(organization_id,batch_id,row_id,revision,request_id,saved_by) VALUES($1,$2,$3,$4,$5,$6)',
    [identity.organization_id, batch.id, id, row.revision, requestId, identity.user_id]);
  await insertCells(client, identity.organization_id, batch.id, [row], batch.columnCount);
  if (batch.resource === 'users') {
    if (credential) await storeUserBulkCredentials(client, identity, batch.id, [row], [credential]);
    else await client.query('SELECT master_bulk_copy_user_credential($1,$2,$3)', [batch.id, id, row.revision]);
  }
  return { id, revision: row.revision };
}
