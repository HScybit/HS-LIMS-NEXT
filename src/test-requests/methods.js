import { database } from '../db/pool.js';
import { datasheets } from '../db/sample-schema.js';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, revision, requirePermission } from '../templates/input.js';
import { resolveCaptureVersion } from '../templates/snapshots.js';
import { createWorkflowCapture } from '../templates/capture.js';
import { requireCaptureWrite } from '../templates/access.js';

export async function applicableMethods(client, identity, requestId) {
  return (await client.query(`SELECT method.id, method.name, method.code FROM test_requests request
    JOIN analytical_specifications specification ON specification.organization_id=request.organization_id AND specification.id=request.specification_id
    JOIN methods_of_analysis method ON method.organization_id=request.organization_id AND method.active
    WHERE request.organization_id=$1 AND request.id=$2 AND
      (NOT EXISTS (SELECT 1 FROM parameter_methods mapping WHERE mapping.organization_id=request.organization_id AND mapping.test_parameter_id=specification.test_parameter_id)
        OR EXISTS (SELECT 1 FROM parameter_methods mapping WHERE mapping.organization_id=request.organization_id AND mapping.test_parameter_id=specification.test_parameter_id AND mapping.method_id=method.id))
    ORDER BY method.name, method.id`, [identity.organization_id, requestId])).rows;
}

async function editableRequest(client, identity, requestId, expectedRevision) {
  await client.query('SELECT laboratory_lock_request_sample($1)', [requestId]);
  const request = (await client.query(`SELECT request.*
    FROM test_requests request WHERE request.organization_id=$1 AND request.id=$2 FOR UPDATE`, [identity.organization_id, requestId])).rows[0];
  if (!request) throw new HttpError(404, 'test_request_not_found', 'Test request was not found.');
  if (request.revision !== expectedRevision) throw new HttpError(409, 'stale_test_request', 'This test request changed. Reload before changing methods.');
  if (!['allocated', 'in_progress', 'rejected'].includes(request.status)) throw new HttpError(409, 'test_request_closed', 'Methods can only be changed while the test request is open for testing.');
  if (request.parent_test_request_id) throw new HttpError(409, 'child_request_method', 'Change methods on the parent test request.');
  const access = (await client.query('SELECT laboratory_request_can_work($1) AS allowed', [request.id])).rows[0];
  if (!access.allowed) throw new HttpError(403, 'method_change_denied', 'Only the assigned analyst can change methods when the sample workflow allows testing and no approval is pending.');
  return request;
}

export async function addTestRequestMethod(client, identity, requestId, input) {
  requirePermission(identity, 'datasheets.execute'); uuid(requestId, 'Test request');
  fieldsOnly(input, ['revision', 'methodId']); revision(input.revision); uuid(input.methodId, 'Method');
  const request = await editableRequest(client, identity, requestId, input.revision);
  const methodId = input.methodId.toLowerCase();
  const available = await applicableMethods(client, identity, request.id);
  if (!available.some((method) => method.id === methodId)) throw new HttpError(422, 'method_not_applicable', 'Select an active method applicable to this parameter.');
  const existing = await client.query(`SELECT id FROM datasheets WHERE organization_id=$1 AND test_request_id=$2 AND method_id=$3 AND status<>'void'`,
    [identity.organization_id, request.id, methodId]);
  if (existing.rowCount) throw new HttpError(409, 'method_already_added', 'This method has already been added.');
  if (!request.datasheet_template_id) throw new HttpError(422, 'datasheet_template_not_configured', 'A datasheet template must be assigned before adding a method.');
  // Copy frozen request facts in PostgreSQL, preserving decimal and timestamp
  // precision. Only the selected method receives a new master snapshot.
  const specificationId = (await client.query('SELECT laboratory_snapshot_method($1,$2) AS id', [request.id, methodId])).rows[0].id;
  const versionId = await resolveCaptureVersion(client, identity, request.datasheet_template_id, { kind: 'datasheet' });
  const capture = await createWorkflowCapture(client, identity, versionId);
  const attempt = (await client.query('SELECT coalesce(max(attempt_number),0)+1 AS number FROM datasheets WHERE organization_id=$1 AND test_request_id=$2',
    [identity.organization_id, request.id])).rows[0].number;
  const [sheet] = await database(client).insert(datasheets).values({ organizationId: identity.organization_id, testRequestId: request.id,
    templateInstanceId: capture.instanceId, specificationId, methodId, attemptNumber: attempt, createdBy: identity.user_id }).returning({ id: datasheets.id });
  const updated = (await client.query('UPDATE test_requests SET revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING revision',
    [identity.organization_id, request.id])).rows[0];
  return { id: request.id, revision: updated.revision, datasheetId: sheet.id };
}

export async function deleteTestRequestMethod(client, identity, requestId, datasheetId, input) {
  requirePermission(identity, 'datasheets.execute'); uuid(requestId, 'Test request'); uuid(datasheetId, 'Datasheet');
  fieldsOnly(input, ['revision']); revision(input.revision);
  const request = await editableRequest(client, identity, requestId, input.revision);
  const sheet = (await client.query(`SELECT * FROM datasheets WHERE organization_id=$1 AND test_request_id=$2 AND id=$3 FOR UPDATE`,
    [identity.organization_id, request.id, datasheetId])).rows[0];
  if (!sheet || sheet.status === 'void') throw new HttpError(404, 'datasheet_not_found', 'This method is no longer on the test request.');
  if (!['in_progress', 'rejected'].includes(sheet.status)) throw new HttpError(409, 'datasheet_closed', 'Only a method open for testing can be deleted.');
  const remaining = await client.query(`SELECT id FROM datasheets WHERE organization_id=$1 AND test_request_id=$2 AND id<>$3 AND status<>'void'`,
    [identity.organization_id, request.id, sheet.id]);
  if (!remaining.rowCount) throw new HttpError(409, 'last_datasheet', 'At least one method must remain on the test request.');
  // Retired captures retain their entered values and history. Freezing here
  // records immutability, never a fabricated submission or approval.
  // The locked request excludes concurrent capture saves. A frozen capture is
  // readable but deliberately invisible to an UPDATE lock under its RLS policy.
  const capture = (await client.query('SELECT status FROM template_instances WHERE organization_id=$1 AND id=$2',
    [identity.organization_id, sheet.template_instance_id])).rows[0];
  if (!capture) throw new HttpError(404, 'capture_not_found', 'The method capture was not found.');
  if (capture.status === 'editing') {
    await requireCaptureWrite(client, sheet.template_instance_id);
    await client.query("UPDATE template_instances SET status='frozen',revision=revision+1 WHERE organization_id=$1 AND id=$2",
      [identity.organization_id, sheet.template_instance_id]);
  }
  await client.query("UPDATE datasheets SET status='void',revision=revision+1 WHERE organization_id=$1 AND id=$2", [identity.organization_id, sheet.id]);
  const updated = (await client.query(`UPDATE test_requests SET final_datasheet_id=CASE WHEN final_datasheet_id=$3 THEN NULL ELSE final_datasheet_id END,
    revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING revision`, [identity.organization_id, request.id, sheet.id])).rows[0];
  return { id: request.id, revision: updated.revision, datasheetId: sheet.id, status: 'void' };
}
