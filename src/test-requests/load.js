import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { workflowStateAccess } from '../workflows/access.js';
import { applicableMethods } from './methods.js';

export async function loadTestRequest(client, identity, requestId, sampleId) {
  uuid(requestId, 'Test request');
  if (sampleId) uuid(sampleId, 'Sample');
  if (!['samples.read', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view test requests.');
  }
  const result = await client.query(`SELECT request.id, request.request_number AS "requestNumber", request.status, request.revision, request.created_at AS "createdAt",
    request.final_datasheet_id AS "finalDatasheetId", product.sample_id AS "sampleId", sample.sample_number AS "sampleNumber",
    coalesce(specification.parameter_name,'Job') AS "parameterName", coalesce(specification.method_name,'Job') AS "methodName", product.product_name AS "productName",
    request.is_job AS "isJob",request.parent_test_request_id AS "parentTestRequestId",
    run.id AS "workflowRunId", coalesce(inherited.target_state_name,state.name) AS "stateName",
    NOT request.is_job AND laboratory_request_can_work(request.id) AS "canChangeMethods"
    FROM test_requests request JOIN laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    JOIN samples sample ON sample.organization_id = product.organization_id AND sample.id = product.sample_id
    LEFT JOIN analytical_specifications specification ON specification.organization_id = request.organization_id AND specification.id = request.specification_id
    LEFT JOIN workflow_runs run ON run.organization_id = request.organization_id AND run.test_request_id = request.id
    LEFT JOIN workflow_states state ON state.organization_id = run.organization_id AND state.id = run.current_state_id
    LEFT JOIN LATERAL (SELECT target_state_name FROM laboratory_job_workflow_effects WHERE organization_id=request.organization_id
      AND test_request_id=request.id AND is_current ORDER BY parent_run_revision DESC LIMIT 1) inherited ON true
    WHERE request.organization_id = $1 AND request.id = $2 AND ($3::uuid IS NULL OR sample.id = $3)`, [identity.organization_id, requestId, sampleId ?? null]);
  if (!result.rowCount) throw new HttpError(404, 'test_request_not_found', 'Test request was not found.');
  const request = result.rows[0];
  const assignments = await client.query(`SELECT id, assigned_user_id AS "assignedUserId", assignment_type AS "assignmentType", assigned_at AS "assignedAt",
    assigned_by AS "assignedBy" FROM test_request_assignments WHERE organization_id = $1 AND test_request_id = $2 AND unassigned_at IS NULL`, [identity.organization_id, requestId]);
  const sheets = await client.query(`SELECT sheet.id, sheet.status, sheet.method_id AS "methodId", sheet.attempt_number AS "attemptNumber", coalesce(specification.method_name,'Job') AS "methodName"
    FROM datasheets sheet LEFT JOIN analytical_specifications specification ON specification.organization_id = sheet.organization_id AND specification.id = sheet.specification_id
    WHERE sheet.organization_id = $1 AND sheet.test_request_id = $2 AND sheet.status<>'void' ORDER BY sheet.attempt_number, sheet.id`, [identity.organization_id, requestId]);
  const methodHistory = await client.query(`SELECT event.id,event.event_type AS action,event.occurred_at AS "occurredAt",event.actor_user_id AS "actorUserId",
    event.description AS comment,event.datasheet_id AS "datasheetId",specification.method_name AS "methodName"
    FROM sample_events event JOIN datasheets sheet ON sheet.organization_id=event.organization_id AND sheet.id=event.datasheet_id
    JOIN analytical_specifications specification ON specification.organization_id=sheet.organization_id AND specification.id=sheet.specification_id
    WHERE event.organization_id=$1 AND event.test_request_id=$2 AND event.event_type IN ('datasheet_method_added','datasheet_method_voided')
    ORDER BY event.occurred_at DESC,event.id DESC LIMIT 100`, [identity.organization_id, requestId]);
  const history = await client.query(`SELECT history.id, history.action, history.occurred_at AS "occurredAt", history.actor_user_id AS "actorUserId", history.comment,
    target.name AS "stateName" FROM workflow_run_history history JOIN workflow_states target
      ON target.organization_id = history.organization_id AND target.id = history.to_state_id
    WHERE history.organization_id = $1 AND history.workflow_run_id = $2 ORDER BY history.occurred_at DESC, history.id DESC LIMIT 100`, [identity.organization_id, request.workflowRunId]);
  const actorIds = [...new Set([...assignments.rows.flatMap((row) => [row.assignedUserId, row.assignedBy]), ...history.rows.map((row) => row.actorUserId), ...methodHistory.rows.map((row) => row.actorUserId)])];
  const labels = actorIds.length ? (await client.query('SELECT * FROM laboratory_actor_labels($1::uuid[])', [actorIds])).rows : [];
  const byId = new Map(labels.map((row) => [row.user_id, row.display_name]));
  const sampleAccess = await workflowStateAccess(client, identity, { type: 'sample', id: request.sampleId });
  return { ...request, assignments: assignments.rows.map((row) => ({ ...row, assignedUserName: byId.get(row.assignedUserId) ?? row.assignedUserId })),
    applicableMethods: request.canChangeMethods ? await applicableMethods(client, identity, requestId) : [],
    methodActivity: methodHistory.rows.map((row) => ({ ...row, actorName: byId.get(row.actorUserId) ?? row.actorUserId })),
    datasheets: sheets.rows, datasheetId: sheets.rows.find((row) => row.id === request.finalDatasheetId)?.id ?? sheets.rows[0]?.id ?? null,
    activity: history.rows.map((row) => ({ ...row, actorName: byId.get(row.actorUserId) ?? row.actorUserId })),
    canAllocate: identity.permission_codes.includes('test_requests.allocate') && request.status === 'created' && sampleAccess.allowedActions.allocate,
    canWork: sampleAccess.allowedActions.workOnTestRequest };
}
