import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { datasheets, testRequestAssignments, sampleEvents } from '../db/sample-schema.js';
import { fieldsOnly, uuid, revision, requirePermission } from '../templates/input.js';
import { createWorkflowCapture } from '../templates/capture.js';
import { resolveCaptureVersion } from '../templates/snapshots.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { startWorkflow } from '../workflows/start.js';

async function ensureDatasheet(client, identity, request) {
  const existing = await client.query(`SELECT id, template_instance_id FROM datasheets
    WHERE organization_id = $1 AND test_request_id = $2 ORDER BY attempt_number DESC LIMIT 1`, [identity.organization_id, request.id]);
  if (existing.rowCount) return { id: existing.rows[0].id, templateId: request.datasheet_template_id };
  let templateId = request.datasheet_template_id;
  if (!templateId) {
    const fallback = await client.query(`SELECT template.id FROM sample_category_templates mapping JOIN templates template
      ON template.organization_id = mapping.organization_id AND template.id = mapping.template_id AND template.active
      WHERE mapping.organization_id = $1 AND mapping.sample_category_id = $2 AND mapping.purpose = 'datasheet' AND mapping.is_default`,
    [identity.organization_id, request.sample_category_id]);
    if (!fallback.rowCount) throw new HttpError(422, 'datasheet_template_not_configured', 'The Test Request requires a datasheet template on its Decision Rule or sample category.');
    templateId = fallback.rows[0].id;
  }
  const versionId = await resolveCaptureVersion(client, identity, templateId, { kind: 'datasheet' });
  const capture = await createWorkflowCapture(client, identity, versionId);
  const [sheet] = await database(client).insert(datasheets).values({ organizationId: identity.organization_id, testRequestId: request.id,
    templateInstanceId: capture.instanceId, specificationId: request.specification_id, methodId: request.method_id, attemptNumber: 1, createdBy: identity.user_id }).returning({ id: datasheets.id });
  return { id: sheet.id, templateId };
}

async function ensureWorkflow(client, identity, request) {
  const existing = await client.query('SELECT id FROM workflow_runs WHERE organization_id = $1 AND test_request_id = $2', [identity.organization_id, request.id]);
  if (existing.rowCount) return existing.rows[0].id;
  const run = await startWorkflow(client, identity, { type: 'test_request', id: request.id }, request.sample_category_id);
  return run?.id ?? null;
}

// The caller supplies the authenticated withSession transaction. Locking the
// request serializes assignments, datasheet creation and capture saves.
export async function allocateTestRequest(client, identity, requestId, input) {
  requirePermission(identity, 'test_requests.allocate'); uuid(requestId, 'Test request');
  fieldsOnly(input, ['revision', 'assignmentType', 'assignedUserId']); revision(input.revision); uuid(input.assignedUserId, 'Assigned user');
  if (!['analyst', 'reviewer', 'final_approver'].includes(input.assignmentType)) throw new HttpError(400, 'invalid_assignment_type', 'Select a supported assignment type.');
  const result = await client.query(`SELECT request.*, product.sample_id, sample.sample_category_id, specification.method_id
    FROM test_requests request JOIN sample_tests selected ON selected.organization_id = request.organization_id AND selected.id = request.sample_test_id
    JOIN sample_products product ON product.organization_id = selected.organization_id AND product.id = selected.sample_product_id
    JOIN samples sample ON sample.organization_id = product.organization_id AND sample.id = product.sample_id
    JOIN analytical_specifications specification ON specification.organization_id = request.organization_id AND specification.id = request.specification_id
    WHERE request.organization_id = $1 AND request.id = $2 FOR UPDATE OF request`, [identity.organization_id, requestId]);
  const request = result.rows[0];
  if (!request) throw new HttpError(404, 'test_request_not_found', 'Test request was not found.');
  if (['approved', 'cancelled'].includes(request.status)) throw new HttpError(409, 'test_request_closed', 'Closed test requests cannot be allocated.');
  if (request.revision !== input.revision) throw new HttpError(409, 'stale_test_request', 'This test request changed; reload before allocating.');
  if (input.assignmentType === 'analyst' && request.status === 'created') await requireWorkflowAction(client, identity, { type: 'sample', id: request.sample_id }, 'allocate');
  const user = await client.query('SELECT user_id FROM laboratory_assignment_users() WHERE user_id = $1', [input.assignedUserId]);
  if (!user.rowCount) throw new HttpError(422, 'invalid_assignee', 'The selected user is not active.');
  const conflictingType = input.assignmentType === 'analyst' ? 'reviewer' : input.assignmentType === 'reviewer' ? 'analyst' : null;
  if (conflictingType) {
    const conflict = await client.query(`SELECT 1 FROM test_request_assignments WHERE organization_id = $1 AND test_request_id = $2
      AND assignment_type = $3 AND assigned_user_id = $4 AND unassigned_at IS NULL`, [identity.organization_id, requestId, conflictingType, input.assignedUserId]);
    if (conflict.rowCount) throw new HttpError(422, 'allocation_role_conflict', 'Assignee and reviewer cannot be the same.');
  }
  await client.query(`UPDATE test_request_assignments SET unassigned_at = now() WHERE organization_id = $1 AND test_request_id = $2
    AND assignment_type = $3 AND unassigned_at IS NULL`, [identity.organization_id, requestId, input.assignmentType]);
  const db = database(client);
  await db.insert(testRequestAssignments).values({ organizationId: identity.organization_id, testRequestId: requestId, assignmentType: input.assignmentType,
    assignedUserId: input.assignedUserId, assignedBy: identity.user_id });
  const prepareRuntime = input.assignmentType === 'analyst' && !request.parent_test_request_id;
  const sheet = prepareRuntime ? await ensureDatasheet(client, identity, request) : null;
  const workflowRunId = prepareRuntime ? await ensureWorkflow(client, identity, request) : null;
  const updated = await client.query(`UPDATE test_requests SET status = CASE WHEN status = 'created' AND $3 = 'analyst' THEN 'allocated' ELSE status END,
    revision = revision + 1, datasheet_template_id = coalesce(datasheet_template_id, $4::uuid)
    WHERE organization_id = $1 AND id = $2 RETURNING revision, status`, [identity.organization_id, requestId, input.assignmentType, sheet?.templateId ?? null]);
  await db.insert(sampleEvents).values({ organizationId: identity.organization_id, sampleId: request.sample_id, testRequestId: requestId,
    eventType: 'test_request_assigned', actorUserId: identity.user_id, description: `Test request ${input.assignmentType.replace('_', ' ')} assigned` });
  return { id: requestId, revision: updated.rows[0].revision, status: updated.rows[0].status, datasheetId: sheet?.id ?? null, workflowRunId };
}
