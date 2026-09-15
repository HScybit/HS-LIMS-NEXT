import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { sampleProducts, sampleTests } from '../db/sample-schema.js';
import { HttpError } from '../auth/errors.js';
import { insertBatch } from '../templates/authoring.js';
import { sampleProductsUpdateInput, temporarySampleOrders } from './lines-input.js';
import { sampleEditReferences } from './edit-references.js';
import { sampleReportingRowsChanged } from './reporting-date.js';
import { sampleReportingDate } from './reporting-estimates.js';

const conflict = message => { throw new HttpError(409, 'sample_lines_changed', message); };
const invalid = message => { throw new HttpError(400, 'invalid_sample', message); };

const productColumns = [
  ['productId', 'product_id', 'uuid'], ['sampleCategoryId', 'sample_category_id', 'uuid'], ['productRevision', 'product_revision', 'integer'],
  ['productCode', 'product_code', 'text'], ['productName', 'product_name', 'text'], ['categoryCode', 'category_code', 'text'], ['categoryName', 'category_name', 'text'],
  ['quantity', 'quantity', 'numeric'], ['customerReference', 'customer_reference', 'text'], ['description', 'description', 'text'],
  ['sampleSize', 'sample_size', 'text'], ['quality', 'quality', 'text'], ['identificationMark', 'identification_mark', 'text'], ['receivedCondition', 'received_condition', 'text'],
  ['measurementUnitId', 'measurement_unit_id', 'uuid'], ['unitCode', 'unit_code', 'text'], ['unitSymbol', 'unit_symbol', 'text'], ['tagId', 'tag_id', 'uuid'], ['tag', 'tag', 'text'],
  ['displayOrder', 'display_order', 'integer'],
];
const testColumns = [
  ['decisionRuleId', 'decision_rule_id', 'uuid'], ['requestedQuantity', 'requested_quantity', 'integer'], ['requestedSize', 'requested_size', 'text'],
  ['rate', 'rate', 'numeric'], ['currencyCode', 'currency_code', 'text'], ['estimatedDurationMinutes', 'estimated_duration_minutes', 'integer'],
  ['isAccredited', 'is_accredited', 'boolean'], ['isSubcontracted', 'is_subcontracted', 'boolean'], ['displayOrder', 'display_order', 'integer'],
];
const orderColumn = [['displayOrder', 'display_order', 'integer']];

// All identifiers and types come from the fixed lists above; submitted values
// travel only in typed arrays. One statement handles the complete batch.
async function updateRows(client, organizationId, table, rows, columns) {
  if (!rows.length) return;
  const args = [organizationId, rows.map(row => row.id), ...columns.map(([key]) => rows.map(row => row[key] ?? null))];
  const casts = ['$2::uuid[]', ...columns.map(([, , type], index) => `$${index + 3}::${type}[]`)];
  const names = ['id', ...columns.map(([, name]) => name)];
  const result = await client.query(`UPDATE ${table} saved SET ${columns.map(([, name]) => `${name}=input.${name}`).join(',')}
    FROM unnest(${casts.join(',')}) AS input(${names.join(',')}) WHERE saved.organization_id=$1 AND saved.id=input.id`, args);
  if (result.rowCount !== rows.length) conflict('A selected sample line or test is no longer available.');
}

export async function reconcileSampleProducts(client, identity, sample, rawProducts, categoryId, receivedAt = sample.receivedAt) {
  const organizationId = identity.organization_id; const db = database(client);
  const lines = sampleProductsUpdateInput(rawProducts, categoryId);
  const previousLines = await db.select().from(sampleProducts).where(and(eq(sampleProducts.organizationId, organizationId), eq(sampleProducts.sampleId, sample.id)))
    .orderBy(sampleProducts.id).limit(101).for('update');
  if (previousLines.length > 100) invalid('This sample exceeds the supported line-edit limit.');
  const lineIds = previousLines.map(line => line.id);
  const selected = lineIds.length ? await db.select({ test: sampleTests, hasRequest: sql`EXISTS (SELECT 1 FROM test_requests request
    WHERE request.organization_id=${sampleTests.organizationId} AND request.sample_test_id=${sampleTests.id})` }).from(sampleTests)
    .where(and(eq(sampleTests.organizationId, organizationId), inArray(sampleTests.sampleProductId, lineIds))).orderBy(sampleTests.id).limit(5001).for('update') : [];
  if (selected.length > 5000) invalid('This sample exceeds the supported test-edit limit.');
  const oldLines = new Map(previousLines.map(line => [line.id, line]));
  const oldTests = new Map(selected.map(({ test, hasRequest }) => [test.id, { ...test, hasRequest, used: hasRequest || test.status !== 'planned' }]));
  const keptLines = new Set(lines.map(line => line.id).filter(Boolean));
  const keptTests = new Map();
  for (const line of lines) {
    if (line.id && !oldLines.has(line.id)) invalid('A sample line does not belong to this sample.');
    for (const test of line.tests) {
      if (!test.id) continue;
      const previous = oldTests.get(test.id);
      if (!previous || previous.sampleProductId !== line.id) invalid('A selected test does not belong to this sample line.');
      keptTests.set(test.id, test);
      if (previous.used && ['testParameterId', 'methodId', 'isRetest'].some(key => test[key] !== previous[key])) conflict('A requested test retains its parameter, method and retest identity.');
    }
  }
  for (const previous of oldTests.values()) if (previous.used && !keptTests.has(previous.id)) conflict('A requested test cannot be removed.');
  const used = await client.query(`SELECT line.id FROM sample_products line WHERE line.organization_id=$1 AND line.sample_id=$2 AND (
    EXISTS (SELECT 1 FROM sample_tests chosen WHERE chosen.organization_id=line.organization_id AND chosen.sample_product_id=line.id AND
      (chosen.status<>'planned' OR EXISTS (SELECT 1 FROM test_requests request WHERE request.organization_id=chosen.organization_id AND request.sample_test_id=chosen.id)))
    OR EXISTS (SELECT 1 FROM test_requests job WHERE job.organization_id=line.organization_id AND job.job_sample_product_id=line.id)
    OR EXISTS (SELECT 1 FROM sample_reports report LEFT JOIN sample_line_contexts context ON context.organization_id=report.organization_id AND context.report_id=report.id
      WHERE report.organization_id=line.organization_id AND report.sample_id=line.sample_id AND (report.sample_product_id=line.id OR report.product_context_line_id=line.id
        OR context.sample_product_id=line.id OR EXISTS (SELECT 1 FROM sample_report_tests member WHERE member.organization_id=report.organization_id AND member.report_id=report.id AND member.sample_product_id=line.id))))`, [organizationId, sample.id]);
  const usedLines = new Set(used.rows.map(row => row.id));
  for (const previous of previousLines) {
    if (usedLines.has(previous.id) && !keptLines.has(previous.id)) conflict('A sample line used by a request or report cannot be removed.');
  }
  for (const line of lines) if (usedLines.has(line.id) && ['productId', 'sampleCategoryId'].some(key => line[key] !== oldLines.get(line.id)[key])) {
    conflict('A sample line used by a request or report retains its product and category.');
  }
  const references = await sampleEditReferences(client, organizationId, sample, categoryId, lines, oldLines, oldTests);
  const products = []; const planned = []; const requested = [];
  for (const [displayOrder, line] of lines.entries()) {
    const previous = oldLines.get(line.id); const id = line.id ?? randomUUID();
    const product = references.products.get(line.productId); const category = references.categories.get(line.sampleCategoryId);
    const unit = references.units.get(line.measurementUnitId);
    const { tests, ...details } = line;
    products.push({ ...details, organizationId, id, sampleId: sample.id, displayOrder,
      productRevision: previous?.productId === line.productId ? previous.productRevision : null,
      productCode: previous?.productId === line.productId ? previous.productCode : product.code,
      productName: previous?.productId === line.productId ? previous.productName : product.name,
      categoryCode: previous?.sampleCategoryId === line.sampleCategoryId ? previous.categoryCode : category.code,
      categoryName: previous?.sampleCategoryId === line.sampleCategoryId ? previous.categoryName : category.name,
      unitCode: line.measurementUnitId ? previous?.measurementUnitId === line.measurementUnitId ? previous.unitCode : unit.code : null,
      unitSymbol: line.measurementUnitId ? previous?.measurementUnitId === line.measurementUnitId ? previous.unitSymbol : unit.symbol : null,
      tag: line.tagId ? previous?.tagId === line.tagId && previous?.productId === line.productId ? previous.tag : references.tags.get(line.tagId).name : line.tag,
    });
    for (const [testOrder, test] of tests.entries()) {
      const record = { ...test, id: test.id ?? randomUUID(), organizationId, sampleProductId: id, displayOrder: testOrder };
      (oldTests.get(test.id)?.used ? requested : planned).push(record);
    }
  }
  const nextTests = [...planned, ...requested];
  const reportingDate = sampleReportingRowsChanged([...oldTests.values()], nextTests)
    ? await sampleReportingDate(client, organizationId, categoryId, products, nextTests, receivedAt) : '';
  const removableTests = [...oldTests.values()].filter(test => !test.used).map(test => test.id);
  if (removableTests.length) await db.delete(sampleTests).where(and(eq(sampleTests.organizationId, organizationId), inArray(sampleTests.id, removableTests)));
  await updateRows(client, organizationId, 'sample_products', temporarySampleOrders(previousLines, products.length), orderColumn);
  const testOrders = lines.flatMap(line => temporarySampleOrders([...oldTests.values()].filter(test => test.sampleProductId === line.id && test.used), line.tests.length));
  await updateRows(client, organizationId, 'sample_tests', testOrders, orderColumn);
  const removedLines = previousLines.filter(line => !keptLines.has(line.id)).map(line => line.id);
  if (removedLines.length) await db.delete(sampleProducts).where(and(eq(sampleProducts.organizationId, organizationId), inArray(sampleProducts.id, removedLines)));
  await updateRows(client, organizationId, 'sample_products', products.filter(line => oldLines.has(line.id)), productColumns);
  await insertBatch(db, sampleProducts, products.filter(line => !oldLines.has(line.id)));
  await updateRows(client, organizationId, 'sample_tests', requested, testColumns);
  await insertBatch(db, sampleTests, planned);
  const category = references.categories.get(categoryId);
  return { reportingDate, changes: categoryId === sample.sampleCategoryId ? {} : { sampleCategoryId: categoryId, categoryCode: category.code,
    categoryName: category.name, categoryAbbreviation: category.abbreviation } };
}
