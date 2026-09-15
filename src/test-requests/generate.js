import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { testRequests, sampleEvents } from '../db/sample-schema.js';
import { fieldsOnly, uuid, requirePermission } from '../templates/input.js';
import { insertBatch } from '../templates/authoring.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { sampleTimestamp } from '../samples/input.js';
import { createSpecifications } from './specifications.js';
import { createAutomaticJobs } from './jobs.js';

export async function generateTestRequests(client, identity, sampleId, input = {}, { automatic = false, workflowRunId = null } = {}) {
  uuid(sampleId, 'Sample');
  if (workflowRunId) {
    uuid(workflowRunId, 'Workflow run');
    if (!automatic) throw new HttpError(403, 'workflow_generation_required', 'Workflow generation requires an automatic transition.');
    await client.query("SELECT set_config('app.workflow_generation_run_id', $1, true)", [workflowRunId]);
    const context = await client.query('SELECT workflow_generating_sample() AS id');
    if (context.rows[0].id !== sampleId) throw new HttpError(403, 'workflow_generation_required', 'Automatic generation requires a recorded workflow transition for this sample.');
  } else if (automatic) {
    requirePermission(identity, 'samples.create');
    const registration = await client.query('SELECT laboratory_registering_sample() AS id');
    if (registration.rows[0].id !== sampleId) throw new HttpError(403, 'registration_required', 'Automatic generation requires an active sample registration.');
  }
  else if (!['samples.manage', 'test_requests.allocate'].some((permission) => identity.permission_codes?.includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot generate test requests.');
  fieldsOnly(input, ['sampleTestIds', 'priority', 'dueAt']);
  const selectedIds = input.sampleTestIds ?? null;
  if (selectedIds !== null) {
    if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 500 || new Set(selectedIds).size !== selectedIds.length) throw new HttpError(400, 'invalid_test_selection', 'Select between 1 and 500 distinct tests.');
    selectedIds.forEach((id) => uuid(id, 'Selected test'));
  }
  const priority = input.priority ?? 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new HttpError(400, 'invalid_priority', 'Select a valid priority.');
  const dueAt = sampleTimestamp(input.dueAt, 'Due date', true);
  const locked = await client.query('SELECT laboratory_lock_sample($1) AS found', [sampleId]);
  if (!locked.rows[0].found) throw new HttpError(404, 'sample_not_found', 'Sample was not found.');
  const sample = (await client.query('SELECT sample_category_id, sample_type, due_at::text AS due_at FROM samples WHERE organization_id = $1 AND id = $2', [identity.organization_id, sampleId])).rows[0];
  if (automatic && sample.sample_type === 'amendment') return { items: [], jobs: [] };
  if (!automatic) {
    const access = await requireWorkflowAction(client, identity, { type: 'sample', id: sampleId }, 'allocate');
    if (!access.state?.generate_test_requests && !access.permissionFallbackActions.allocate) throw new HttpError(403, 'workflow_action_denied', 'The current workflow state does not allow test-request generation.');
  }
  const tests = await client.query(`SELECT test.id, test.test_parameter_id AS "testParameterId", test.method_id AS "methodId", test.decision_rule_id AS "decisionRuleId",
    product.product_id AS "productId", product.id AS "sampleProductId", product.sample_category_id AS "sampleCategoryId" FROM sample_tests test JOIN sample_products product
      ON product.organization_id = test.organization_id AND product.id = test.sample_product_id
    WHERE test.organization_id = $1 AND product.sample_id = $2 AND ($3::uuid[] IS NULL OR test.id = ANY($3)) AND test.status = 'planned'
      AND (NOT $4::boolean OR test.is_retest)
    ORDER BY product.display_order, test.display_order, test.id FOR UPDATE OF test`, [identity.organization_id, sampleId, selectedIds, sample.sample_type === 'complaint']);
  if (selectedIds && tests.rowCount !== selectedIds.length) throw new HttpError(409, 'sample_test_not_available', 'A selected sample test is missing, already requested or not selected for retest.');
  if (!tests.rowCount) return { items: [], jobs: [] };
  const specifications = await createSpecifications(client, identity, tests.rows);
  const numbers = await client.query("SELECT laboratory_next_number('test_request', extract(year FROM now() AT TIME ZONE 'UTC')::integer::text) AS number FROM generate_series(1, $1::integer)", [tests.rowCount]);
  const records = tests.rows.map((test, index) => ({ organizationId: identity.organization_id, id: randomUUID(), sampleTestId: test.id,
    requestNumber: numbers.rows[index].number, specificationId: specifications.get(test.id).id, datasheetTemplateId: specifications.get(test.id).templateId,
    priority, dueAt: dueAt ? new Date(dueAt) : sample.due_at == null ? null : sql`${sample.due_at}::timestamptz`, createdBy: identity.user_id }));
  await insertBatch(database(client), testRequests, records);
  await client.query("UPDATE sample_tests SET status = 'requested' WHERE organization_id = $1 AND id = ANY($2::uuid[])", [identity.organization_id, tests.rows.map((test) => test.id)]);
  await database(client).insert(sampleEvents).values({ organizationId: identity.organization_id, sampleId, eventType: 'test_requests_generated', actorUserId: identity.user_id,
    description: `${records.length} test request${records.length === 1 ? '' : 's'} generated` });
  const grouped = await createAutomaticJobs(client, identity, sampleId, records.map((record, index) => ({ id: record.id, sampleProductId: tests.rows[index].sampleProductId })));
  return { items: records.map((record) => ({ id: record.id, requestNumber: record.requestNumber,
    datasheetId: grouped.members.get(record.id)?.datasheetId ?? null, workflowRunId: grouped.members.get(record.id)?.workflowRunId ?? null })), jobs: grouped.jobs };
}
