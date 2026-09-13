import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { productDetailCustomKey, productDetailSelector, productDetailProjection } from '../templates/product-context.js';

const limits = Object.freeze({ lines: 100, fields: 50_000, values: 500_000, textBytes: 16 * 1024 * 1024 });
const incomplete = () => new HttpError(409, 'incomplete_sample_product_history', 'The captured Product history is incomplete.');
const tooLarge = () => new HttpError(422, 'sample_product_context_limit', 'The requested Product details exceed the supported document size.');

function primitive(row, prefix) {
  const kind = row[`${prefix}Kind`];
  const key = { text: 'Text', number: 'Number', boolean: 'Boolean' }[kind];
  const value = key && row[`${prefix}${key}`];
  if ((kind === 'text' && typeof value === 'string') || (kind === 'number' && typeof value === 'number' && Number.isFinite(value))
    || (kind === 'boolean' && typeof value === 'boolean')) return value;
  throw incomplete();
}

// One Product model per captured sample line; repeated widgets share its maps.
// Header and item rows are ordered in SQL, then checked rather than truncated.
export function assembleSampleProductContext(headers, fields = [], values = []) {
  const productsByLineId = Object.create(null); const fieldsById = new Map();
  for (const row of headers) {
    if (Object.hasOwn(productsByLineId, row.sampleProductId) || (row.productRevision !== null && !row.historyAvailable)
      || (row.historyAvailable && (row.tagIds.length !== row.tagCount || row.actualFieldCount !== row.customFieldCount))) throw incomplete();
    const product = { id: row.productId, sampleProductId: row.sampleProductId, revision: row.productRevision, historyAvailable: row.historyAvailable,
      organizationId: row.organizationId, code: row.code, name: row.name, customFieldsByKey: Object.create(null) };
    if (row.historyAvailable) Object.assign(product, { description: row.description, abbreviation: row.abbreviation,
      jobTemplateId: row.jobTemplateId, tagIds: row.tagIds, createdBy: row.createdBy,
      createdAt: row.createdAt?.toISOString() ?? null, updatedAt: row.updatedAt?.toISOString() ?? null });
    productsByLineId[row.sampleProductId] = product;
  }
  for (const row of fields) {
    const product = productsByLineId[row.sampleProductId]; const id = `${row.sampleProductId}:${row.fieldId}`;
    if (!product?.historyAvailable || fieldsById.has(id) || Object.hasOwn(product.customFieldsByKey, row.key)
      || !Number.isInteger(row.valueCount) || row.valueCount < 0 || row.valueCount > 500 || (!row.isArray && row.valueCount !== 1)) throw incomplete();
    const field = { fieldId: row.fieldId, fieldRevision: row.fieldRevision, key: row.key, label: row.label,
      displayValue: primitive(row, 'display'), value: row.isArray ? [] : undefined };
    product.customFieldsByKey[row.key] = field;
    fieldsById.set(id, { field, isArray: row.isArray, expected: row.valueCount, count: 0 });
  }
  for (const row of values) {
    const selected = fieldsById.get(`${row.sampleProductId}:${row.fieldId}`);
    if (!selected || row.position !== selected.count || selected.count >= selected.expected) throw incomplete();
    const value = primitive(row, 'raw');
    if (selected.isArray) selected.field.value.push(value); else selected.field.value = value;
    selected.count += 1;
  }
  for (const { count, expected } of fieldsById.values()) if (count !== expected) throw incomplete();
  return { productsByLineId, primaryProductLineId: headers[0]?.sampleProductId ?? null };
}

export async function loadSampleProductContext(client, identity, sampleId, identifiers = [], { sampleProductIds } = {}) {
  uuid(sampleId, 'Sample');
  const selectedLines = sampleProductIds === undefined ? null : [...new Set(sampleProductIds.map((id) => uuid(id, 'Sample Product').toLowerCase()))];
  if (selectedLines?.length > limits.lines) throw tooLarge();
  const selectors = new Set(identifiers.map(productDetailSelector));
  if (selectors.size > 20_000 || [...selectors].some((key) => key.length > 200)) throw tooLarge();
  const keys = [...selectors].map(productDetailCustomKey).filter((key) => key !== null);
  const metrics = { queryCount: 0, databaseMs: 0, assemblyMs: 0 };
  const query = async (statement, parameters) => {
    const started = performance.now(); metrics.queryCount += 1;
    try { return (await client.query(statement, parameters)).rows; } finally { metrics.databaseMs += performance.now() - started; }
  };
  const headers = await query(`SELECT organization_id AS "organizationId",sample_product_id AS "sampleProductId",product_id AS "productId",
    product_revision AS "productRevision",history_available AS "historyAvailable",code,name,description,abbreviation,job_template_id AS "jobTemplateId",
    tag_count AS "tagCount",tag_ids AS "tagIds",custom_field_count AS "customFieldCount",actual_field_count AS "actualFieldCount",
    created_at AS "createdAt",created_by AS "createdBy",updated_at AS "updatedAt"
    FROM laboratory_product_context WHERE organization_id=$1 AND sample_id=$2 AND ($3::uuid[] IS NULL OR sample_product_id=ANY($3::uuid[]))
    ORDER BY display_order,sample_product_id LIMIT 101`, [identity.organization_id, sampleId, selectedLines]);
  if (headers.length > limits.lines) throw tooLarge();
  if (selectedLines && headers.length !== selectedLines.length) throw incomplete();
  const headerBytes = headers.reduce((total, row) => total + Buffer.byteLength(row.code) + Buffer.byteLength(row.name)
    + Buffer.byteLength(row.description ?? '') + Buffer.byteLength(row.abbreviation ?? ''), 0);
  if (headerBytes > limits.textBytes) throw tooLarge();
  let fields = []; let values = [];
  if (keys.length && headers.some((row) => row.customFieldCount > 0)) {
    const parameters = [identity.organization_id, sampleId, keys, selectedLines];
    // Aggregate lengths/counts before retrieving potentially multi-megabyte
    // display strings. The underlying revisions are immutable across reads.
    const [budget] = await query(`WITH field_budget AS (
      SELECT count(*) AS fields,coalesce(sum(octet_length(field_key)+octet_length(label)+coalesce(octet_length(display_text),0)),0) AS bytes
      FROM laboratory_product_field_context
      WHERE organization_id=$1 AND sample_id=$2 AND field_key=ANY($3::text[]) AND ($4::uuid[] IS NULL OR sample_product_id=ANY($4::uuid[]))
    ), value_budget AS (
      SELECT count(*) AS values,coalesce(sum(coalesce(octet_length(raw_text),0)),0) AS bytes
      FROM laboratory_product_value_context WHERE organization_id=$1 AND sample_id=$2 AND field_key=ANY($3::text[])
        AND ($4::uuid[] IS NULL OR sample_product_id=ANY($4::uuid[]))
    ) SELECT field_budget.fields,value_budget.values,field_budget.bytes+value_budget.bytes AS bytes FROM field_budget,value_budget`, parameters);
    const fieldCount = Number(budget.fields); const valueCount = Number(budget.values); const textBytes = Number(budget.bytes);
    if (![fieldCount, valueCount, textBytes].every(Number.isSafeInteger) || fieldCount > limits.fields || valueCount > limits.values
      || textBytes + headerBytes > limits.textBytes) throw tooLarge();
    if (fieldCount) {
      fields = await query(`SELECT sample_product_id AS "sampleProductId",field_id AS "fieldId",field_revision AS "fieldRevision",
        field_key AS key,label,is_array AS "isArray",value_count AS "valueCount",display_kind AS "displayKind",
        display_text AS "displayText",display_number AS "displayNumber",display_boolean AS "displayBoolean"
        FROM laboratory_product_field_context WHERE organization_id=$1 AND sample_id=$2 AND field_key=ANY($3::text[])
          AND ($4::uuid[] IS NULL OR sample_product_id=ANY($4::uuid[]))
        ORDER BY sample_product_id,position LIMIT 50001`, parameters);
      if (fields.length !== fieldCount) throw incomplete();
      if (valueCount) values = await query(`SELECT sample_product_id AS "sampleProductId",field_id AS "fieldId",position,
        raw_kind AS "rawKind",raw_text AS "rawText",raw_number AS "rawNumber",raw_boolean AS "rawBoolean"
        FROM laboratory_product_value_context WHERE organization_id=$1 AND sample_id=$2 AND field_key=ANY($3::text[])
          AND ($4::uuid[] IS NULL OR sample_product_id=ANY($4::uuid[]))
        ORDER BY sample_product_id,field_id,position LIMIT 500001`, parameters);
      if (values.length !== valueCount) throw incomplete();
    } else if (valueCount) throw incomplete();
  }
  const started = performance.now(); const result = assembleSampleProductContext(headers, fields, values);
  const productDetailsByLineId = Object.fromEntries(Object.entries(result.productsByLineId).map(([id, product]) => [id, productDetailProjection(product, selectors)]));
  metrics.assemblyMs = performance.now() - started;
  return { ...result, productDetailsByLineId, metrics };
}
