import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid } from '../templates/input.js';
import { productInput, loadProduct, saveProduct } from './products.js';
import { testParameterInput, loadTestParameter, saveTestParameter } from './test-parameters.js';
import { methodInput, loadMethod, saveMethod, generatedMethodCode } from './methods.js';
import { productCustomFields, parameterCustomFields, methodCustomFields } from './custom-fields.js';
import { prepareMasterCustomFieldValues, lockMasterCustomFieldCapture } from './master-custom-field-values.js';
import { lockMethodCustomFieldCapture } from './method-custom-fields.js';
import { bindMasterBulkColumns } from './bulk-columns.js';
import { bulkCellValue, bulkRowKey, masterBulkResource, masterBulkRowCommand, requiredBulkColumns } from './bulk-row.js';
import { masterBulkChunkSize } from './bulk-config.js';
import { loadMasterBulkBatch, loadMasterBulkCells } from './bulk-store.js';
import { prepareUserBulkRow, userBulkContext } from '../users/bulk-service.js';

const resources = {
  products: { kind: 'product', table: 'products', key: 'code', input: productInput, load: loadProduct, save: saveProduct, fields: productCustomFields },
  'test-parameters': { kind: 'parameter', table: 'test_parameters', key: 'master_key', input: testParameterInput, load: loadTestParameter, save: saveTestParameter, fields: parameterCustomFields },
  methods: { kind: 'method', table: 'methods_of_analysis', key: 'method_uuid', input: methodInput, load: loadMethod, save: saveMethod, fields: methodCustomFields },
};
const invalid = message => new HttpError(400, 'invalid_bulk_row', message);
const stale = message => new HttpError(409, 'stale_bulk_review', message);
const idValue = (value, label) => uuid(value, label).toLowerCase();

function requestsInput(input, process) {
  fieldsOnly(input, ['rows']);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > masterBulkChunkSize) throw invalid(`Choose between 1 and ${masterBulkChunkSize} rows.`);
  const rows = input.rows.map(row => {
    fieldsOnly(row, process ? ['id', 'revision', 'requestId', 'reviewId'] : ['id', 'revision', 'requestId']);
    return { id: idValue(row.id, 'Row'), revision: integer(row.revision, 'Input revision', 1, 2_147_483_647), requestId: idValue(row.requestId, 'Request'),
      ...(process ? { reviewId: idValue(row.reviewId, 'Review') } : {}) };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.requestId)).size !== rows.length) throw invalid('Choose each row and request once.');
  return rows;
}

async function lockRows(client, identity, batch, requests) {
  const rows = (await client.query(`SELECT id,revision FROM master_bulk_rows WHERE organization_id=$1 AND batch_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
    [identity.organization_id, batch.id, requests.map(row => row.id)])).rows;
  if (rows.length !== requests.length) throw new HttpError(404, 'bulk_row_not_found', 'An upload row was not found.');
  return new Map(rows.map(row => [row.id, row]));
}

function safeFailure(error) {
  if (error.status === 401 || error.status === 403 || error.code === '42501') throw new HttpError(403, 'forbidden', 'An active session with access to this upload is required.');
  if (error instanceof HttpError) return { code: error.code.slice(0, 100), message: error.message.slice(0, 2000) };
  throw error;
}

function referenceResolver(client, identity) {
  const cache = new Map();
  const queries = {
    laboratoryId: 'SELECT id,name FROM laboratories WHERE organization_id=$1 AND active',
    jobTemplateId: 'SELECT template_id AS id,name FROM product_template_labels WHERE organization_id=$1 AND active',
    tagIds: 'SELECT id,name FROM tags WHERE organization_id=$1 AND active',
    accessUserIds: 'SELECT id,email,username,display_name AS name FROM master_bulk_user_labels WHERE organization_id=$1 AND active',
  };
  return async (field, requested) => {
    if (!requested.length) return [];
    const cacheKey = `${field}:${JSON.stringify(requested)}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const tokens = [...new Set(requested.map(value => value.toLowerCase()))];
    const base = queries[field];
    if (!base) throw invalid('Unsupported reference column.');
    // Resolve only requested values. Never load an unbounded master/user directory.
    const rows = (await client.query(`SELECT * FROM (${base}) candidates WHERE lower(id::text)=ANY($2::text[]) OR lower(name)=ANY($2::text[])
      ${field === 'accessUserIds' ? 'OR lower(email)=ANY($2::text[]) OR lower(username)=ANY($2::text[])' : ''} LIMIT 1001`, [identity.organization_id, tokens])).rows;
    if (rows.length > 1000) throw invalid('Reference names are ambiguous; use their identifiers.');
    const resolved = requested.map(value => {
      const normalized = value.toLowerCase();
      const exact = rows.find(row => row.id === normalized);
      const matches = exact ? [exact] : rows.filter(row => [row.name, row.email, row.username].some(label => label?.toLowerCase() === normalized));
      if (matches.length !== 1) throw invalid(`${field}: ${matches.length ? 'More than one record matches' : 'No active record matches'} “${value}”. Use an available identifier or unique name.`);
      return matches[0].id;
    });
    const result = [...new Set(resolved)]; cache.set(cacheKey, result); return result;
  };
}

async function contextFor(client, identity, batch, requestedRows) {
  if (batch.resource === 'users') return userBulkContext(client, identity, batch, requestedRows);
  masterBulkResource(batch.resource); const store = resources[batch.resource];
  const definitions = await store.fields(client, identity);
  // Trailing unheaded blanks retain provenance but are not authoring columns.
  const headers = batch.columns.map(column => column.header);
  while (headers.length && !headers.at(-1).trim()) headers.pop();
  const columns = bindMasterBulkColumns(batch.resource, headers, definitions); requiredBulkColumns(batch.resource, columns);
  const definitionHash = createHash('sha256').update(JSON.stringify(definitions.map(field => [field.id, field.revision]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
  const duplicateFields = [masterBulkResource(batch.resource).key, ...(batch.resource === 'test-parameters' ? ['schemeAbbreviation'] : [])];
  const keyColumns = columns.filter(column => column.kind === 'master' && duplicateFields.includes(column.fieldName));
  const duplicates = new Map(keyColumns.map(column => [column.fieldName, new Map()]));
  const values = (await client.query(`SELECT cell.row_id AS "rowId",cell.column_number AS "columnNumber",cell.value_kind AS kind,
    cell.text_value AS "textValue",cell.number_value AS "numberValue",cell.boolean_value AS "booleanValue",cell.date_value AS "dateValue"
    FROM master_bulk_cells cell JOIN master_bulk_rows row ON row.organization_id=cell.organization_id AND row.batch_id=cell.batch_id AND row.id=cell.row_id AND row.revision=cell.revision
    WHERE cell.organization_id=$1 AND cell.batch_id=$2 AND cell.column_number=ANY($3::integer[])`,
  [identity.organization_id, batch.id, keyColumns.map(column => column.columnNumber)])).rows;
  for (const cell of values) {
    const field = keyColumns.find(column => column.columnNumber === cell.columnNumber).fieldName;
    const key = String(bulkCellValue(cell.kind === 'missing' ? '' : cell[`${cell.kind}Value`]));
    if (!key) continue;
    const entries = duplicates.get(field); entries.set(key, (entries.get(key) ?? 0) + 1);
  }
  return { store, definitions, columns, definitionHash, duplicates, resolve: referenceResolver(client, identity) };
}

async function prepareRow(client, identity, batch, context, row, reviewId, expected) {
  if (batch.resource === 'users') return prepareUserBulkRow(batch, context, row, reviewId, expected);
  const { store, definitions, columns, definitionHash, duplicates, resolve } = context;
  if (row.values.slice(columns.length).some(value => bulkCellValue(value) !== '')) throw invalid('A value was entered in a column without a header.');
  const key = bulkRowKey(batch.resource, columns, row.values);
  if (!key) throw invalid('The matching key must not be blank.');
  for (const [field, counts] of duplicates) {
    const column = columns.find(column => column.fieldName === field);
    const value = String(bulkCellValue(row.values[column.columnNumber - 1]));
    if ((counts.get(value) ?? 0) > 1) throw invalid(`${column.header.trim()}: “${value}” occurs more than once in this upload.`);
  }
  const current = (await client.query(`SELECT id,revision,active FROM ${store.table} WHERE organization_id=$1 AND ${store.key}=$2`, [identity.organization_id, key])).rows[0];
  if (expected && (expected.definitions_sha256 !== definitionHash || (current?.revision ?? 0) !== expected.expected_revision
    || current && current.id !== expected.candidate_id)) throw stale('The matching record or Custom Fields changed. Validate this row again before processing.');
  const candidateId = current?.id ?? expected?.candidate_id ?? randomUUID();
  const previous = current ? await store.load(client, identity, current.id, current.active ? undefined : { atRevision: current.revision }) : null;
  const command = await masterBulkRowCommand({ resource: batch.resource, columns, row, definitions, previous, id: candidateId,
    requestId: reviewId, timeZone: batch.timeZone, resolve });
  const normalized = store.input(command);
  const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
  if (expected && expected.command_sha256 !== commandHash) throw stale('A resolved reference or saved value changed. Validate this row again before processing.');
  await prepareMasterCustomFieldValues(store.kind, client, identity, { definitions, entries: normalized.customFields,
    timeZone: normalized.customFieldTimeZone, previousFields: previous?.customFields ?? [] });
  if (batch.resource === 'test-parameters') {
    const duplicate = await client.query('SELECT 1 FROM test_parameters WHERE organization_id=$1 AND id<>$2 AND scheme_abbreviation=$3', [identity.organization_id, candidateId, normalized.schemeAbbreviation]);
    if (duplicate.rowCount) throw invalid('Scheme abbreviation is already used by another Parameter.');
  }
  if (batch.resource === 'methods' && !current) {
    const duplicate = await client.query('SELECT 1 FROM methods_of_analysis WHERE organization_id=$1 AND code=$2', [identity.organization_id, generatedMethodCode(normalized.uuid)]);
    if (duplicate.rowCount) throw invalid('This UUID produces a Method code that is already in use.');
  }
  return { command, commandHash, candidateId, expectedRevision: normalized.revision, definitionHash,
    operation: !current ? 'create' : current.active ? 'update' : batch.resource === 'products' ? 'reactivate' : 'update_retired' };
}

export async function reviewMasterBulk(client, identity, batchId, input) {
  const requests = requestsInput(input, false);
  const batch = await loadMasterBulkBatch(client, identity, batchId);
  const locked = await lockRows(client, identity, batch, requests);
  const rows = new Map((await loadMasterBulkCells(client, identity, batch.id, [...locked.values()])).map(row => [row.id, row]));
  let context; let contextFailure;
  try { context = await contextFor(client, identity, batch, [...locked.values()]); } catch (error) { contextFailure = safeFailure(error); }
  const results = [];
  for (const request of requests) {
    const prior = (await client.query('SELECT batch_id,row_id,input_revision,saved_by,valid FROM master_bulk_reviews WHERE organization_id=$1 AND id=$2', [identity.organization_id, request.requestId])).rows[0];
    if (prior) {
      if (prior.batch_id !== batch.id || prior.row_id !== request.id || prior.input_revision !== request.revision || prior.saved_by !== identity.user_id) throw new HttpError(409, 'bulk_request_reused', 'This review request was already used.');
      results.push({ id: request.id, reviewId: request.requestId, valid: prior.valid }); continue;
    }
    if (locked.get(request.id).revision !== request.revision) throw stale('Input cells changed. Reload before validating.');
    if ((await client.query('SELECT 1 FROM master_bulk_attempts WHERE organization_id=$1 AND batch_id=$2 AND row_id=$3 AND committed', [identity.organization_id, batch.id, request.id])).rowCount) {
      results.push({ id: request.id, committed: true }); continue;
    }
    let result; let failure = contextFailure;
    if (!failure) {
      try { result = await prepareRow(client, identity, batch, context, rows.get(request.id), request.requestId); }
      catch (error) { failure = safeFailure(error); }
    }
    await client.query(`INSERT INTO master_bulk_reviews(organization_id,id,batch_id,row_id,input_revision,valid,candidate_id,expected_revision,operation,definitions_sha256,command_sha256,error_code,error_message,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [identity.organization_id, request.requestId, batch.id, request.id, request.revision, !failure,
      result?.candidateId ?? null, result?.expectedRevision ?? null, result?.operation ?? null, result?.definitionHash ?? null, result?.commandHash ?? null,
      failure?.code ?? null, failure?.message ?? null, identity.user_id]);
    results.push({ id: request.id, reviewId: request.requestId, valid: !failure, operation: result?.operation, error: failure });
  }
  return { rows: results };
}

export async function processMasterBulk(client, identity, batchId, input) {
  const requests = requestsInput(input, true);
  const batch = await loadMasterBulkBatch(client, identity, batchId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('master-bulk-process:'||$1::text,0))", [identity.organization_id]);
  if (batch.resource === 'users') await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]);
  else await lockMasterCustomFieldCapture(client);
  if (batch.resource === 'methods') await lockMethodCustomFieldCapture(client);
  const locked = await lockRows(client, identity, batch, requests);
  const rows = new Map((await loadMasterBulkCells(client, identity, batch.id, [...locked.values()])).map(row => [row.id, row]));
  let context; let contextFailure;
  try { context = await contextFor(client, identity, batch, [...locked.values()]); } catch (error) { contextFailure = safeFailure(error); }
  const results = [];
  for (const request of requests) {
    const prior = (await client.query('SELECT * FROM master_bulk_attempts WHERE organization_id=$1 AND id=$2', [identity.organization_id, request.requestId])).rows[0];
    if (prior) {
      if (prior.batch_id !== batch.id || prior.row_id !== request.id || prior.input_revision !== request.revision || prior.review_id !== request.reviewId || prior.saved_by !== identity.user_id) throw new HttpError(409, 'bulk_request_reused', 'This processing request was already used.');
      results.push({ id: request.id, committed: prior.committed, resultId: prior.product_id ?? prior.parameter_id ?? prior.method_id ?? prior.user_id,
        resultRevision: prior.result_revision, error: prior.error_code ? { code: prior.error_code, message: prior.error_message } : null }); continue;
    }
    const committed = (await client.query('SELECT product_id,parameter_id,method_id,user_id,result_revision FROM master_bulk_attempts WHERE organization_id=$1 AND batch_id=$2 AND row_id=$3 AND committed', [identity.organization_id, batch.id, request.id])).rows[0];
    if (committed) {
      results.push({ id: request.id, committed: true, resultId: committed.product_id ?? committed.parameter_id ?? committed.method_id ?? committed.user_id, resultRevision: committed.result_revision, error: null }); continue;
    }
    if (locked.get(request.id).revision !== request.revision) throw stale('Input cells changed. Validate again before processing.');
    const review = (await client.query('SELECT * FROM master_bulk_reviews WHERE organization_id=$1 AND id=$2 AND batch_id=$3 AND row_id=$4 AND input_revision=$5',
      [identity.organization_id, request.reviewId, batch.id, request.id, request.revision])).rows[0];
    if (!review?.valid) throw stale('Validate the row successfully before processing.');
    let saved; let failure = contextFailure;
    await client.query('SAVEPOINT master_bulk_row');
    try {
      if (!failure) {
        const prepared = await prepareRow(client, identity, batch, context, rows.get(request.id), review.id, review);
        saved = await context.store.save(client, identity, prepared.command, { bulkUpdate: true });
        // Deferred master/history failures belong to this row, not a misleading
        // success followed by failure of the entire processing response.
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
      }
      await client.query('RELEASE SAVEPOINT master_bulk_row');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT master_bulk_row'); await client.query('RELEASE SAVEPOINT master_bulk_row');
      failure = safeFailure(error);
    }
    await client.query(`INSERT INTO master_bulk_attempts(organization_id,id,batch_id,row_id,input_revision,review_id,committed,product_id,parameter_id,method_id,user_id,result_revision,error_code,error_message,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [identity.organization_id, request.requestId, batch.id, request.id, request.revision, review.id, !failure,
      !failure && batch.resource === 'products' ? saved.id : null, !failure && batch.resource === 'test-parameters' ? saved.id : null,
      !failure && batch.resource === 'methods' ? saved.id : null, !failure && batch.resource === 'users' ? saved.id : null,
      !failure ? saved.revision : null, failure?.code ?? null, failure?.message ?? null, identity.user_id]);
    results.push({ id: request.id, committed: !failure, resultId: saved?.id ?? null, resultRevision: saved?.revision ?? null, error: failure ?? null });
  }
  return { rows: results, committed: results.filter(row => row.committed).length, rejected: results.filter(row => !row.committed).length };
}
