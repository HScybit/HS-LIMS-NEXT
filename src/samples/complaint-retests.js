import { and, eq } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { sampleProducts } from '../db/sample-schema.js';
import { HttpError } from '../auth/errors.js';
import { complaintRetestInput } from './complaint-input.js';
import { sampleReportingRowsChanged } from './reporting-date.js';
import { sampleReportingDate } from './reporting-estimates.js';

// Called with the owning sample and workflow already locked by updateSample.
export async function updateComplaintRetests(client, identity, sample, input) {
  const ids = complaintRetestInput(input); const selected = new Set(ids);
  const organizationId = identity.organization_id;
  const products = await database(client).select({ id: sampleProducts.id, productId: sampleProducts.productId, sampleCategoryId: sampleProducts.sampleCategoryId })
    .from(sampleProducts).where(and(eq(sampleProducts.organizationId, organizationId), eq(sampleProducts.sampleId, sample.id)))
    .orderBy(sampleProducts.id).limit(101).for('update');
  if (products.length > 100) throw new HttpError(400, 'invalid_complaint_retest', 'This complaint exceeds the supported line-edit limit.');
  const { rows: tests } = await client.query(`SELECT test.id,test.sample_product_id AS "sampleProductId",test.test_parameter_id AS "testParameterId",
    test.method_id AS "methodId",test.estimated_duration_minutes AS "estimatedDurationMinutes",test.is_retest AS "isRetest",test.status,
    EXISTS(SELECT 1 FROM test_requests request WHERE request.organization_id=test.organization_id AND request.sample_test_id=test.id) AS "hasRequest"
    FROM sample_tests test WHERE test.organization_id=$1 AND test.sample_product_id=ANY($2::uuid[]) ORDER BY test.id LIMIT 5001 FOR UPDATE`,
  [organizationId, products.map(product => product.id)]);
  if (tests.length > 5000) throw new HttpError(400, 'invalid_complaint_retest', 'This complaint exceeds the supported test-edit limit.');
  const kept = tests.filter(test => selected.has(test.id));
  if (kept.length !== ids.length) throw new HttpError(422, 'invalid_complaint_retest', 'A selected retest does not belong to this complaint.');
  for (const test of tests) if ((test.hasRequest || test.status !== 'planned') && (!selected.has(test.id) || !test.isRetest)) {
    throw new HttpError(409, 'sample_lines_changed', 'A complaint test already in use cannot be removed or have its retest identity changed.');
  }
  const contexts = kept.map(test => `${test.sampleProductId}:${test.testParameterId}:${test.methodId}`);
  if (new Set(contexts).size !== kept.length) {
    throw new HttpError(422, 'invalid_complaint_retest', 'Select each parameter and method only once per complaint product line.');
  }
  const keptLines = new Set(kept.map(test => test.sampleProductId));
  const reportingDate = sampleReportingRowsChanged(tests, kept)
    ? await sampleReportingDate(client, organizationId, sample.sampleCategoryId, products.filter(product => keptLines.has(product.id)), kept, sample.receivedAt) : '';
  const removed = tests.filter(test => !selected.has(test.id)).map(test => test.id);
  if (removed.length) await client.query('DELETE FROM sample_tests WHERE organization_id=$1 AND id=ANY($2::uuid[])', [organizationId, removed]);
  const marked = kept.filter(test => !test.isRetest).map(test => test.id);
  if (marked.length) await client.query('UPDATE sample_tests SET is_retest=true WHERE organization_id=$1 AND id=ANY($2::uuid[])', [organizationId, marked]);
  return reportingDate;
}
