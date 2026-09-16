import { requirePermission, uuid } from '../templates/input.js';
import { HttpError } from '../auth/errors.js';
import { workflowStateAccess } from '../workflows/access.js';

export async function sampleTestRequests(client, identity, sampleId) {
  uuid(sampleId, 'Sample');
  if (!['samples.read', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes.includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view test requests.');
  const sample = (await client.query('SELECT id, sample_number AS "sampleNumber" FROM samples WHERE organization_id=$1 AND id=$2', [identity.organization_id, sampleId])).rows[0];
  if (!sample) throw new HttpError(404, 'sample_not_found', 'Sample was not found.');
  const access = await workflowStateAccess(client, identity, { type: 'sample', id: sampleId });
  const result = await client.query(`SELECT request.id, request.request_number AS "requestNumber", request.status, request.revision, request.created_at AS "createdAt",
    request.due_at AS "dueAt", greatest(0, floor(extract(epoch FROM (now()-request.created_at))/86400))::integer AS "ageDays",
    request.parent_test_request_id AS "parentRequestId", request.is_job AS "isJob", product.product_name AS "productName",
    coalesce(specification.parameter_name,'Job') AS "parameterName", coalesce(specification.method_name,'Job') AS "methodName", coalesce(inherited.target_state_name,state.name) AS "stateName",
    EXISTS(SELECT 1 FROM test_request_assignments assignment WHERE assignment.organization_id=request.organization_id
      AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL) AS "hasAnalyst",
    coalesce(request.using_dynamic_workflow,EXISTS(SELECT 1 FROM sample_category_workflows mapping JOIN workflows workflow
      ON workflow.organization_id=mapping.organization_id AND workflow.id=mapping.workflow_id AND workflow.active
      JOIN workflow_versions version ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published'
      WHERE mapping.organization_id=request.organization_id AND mapping.sample_category_id=product.sample_category_id AND mapping.applies_to='test_request' AND mapping.is_default)) AS "usesDynamicWorkflow"
    FROM test_requests request JOIN laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    LEFT JOIN analytical_specifications specification ON specification.organization_id=request.organization_id AND specification.id=request.specification_id
    LEFT JOIN workflow_runs run ON run.organization_id=request.organization_id AND run.test_request_id=request.id
    LEFT JOIN workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    LEFT JOIN LATERAL (SELECT target_state_name FROM laboratory_job_workflow_effects WHERE organization_id=request.organization_id
      AND test_request_id=request.id AND is_current ORDER BY parent_run_revision DESC LIMIT 1) inherited ON true
    WHERE request.organization_id=$1 AND product.sample_id=$2 ORDER BY request.created_at, request.request_number, request.id`, [identity.organization_id, sampleId]);
  const canAllocate = identity.permission_codes.includes('test_requests.allocate') && access.allowedActions.allocate;
  const users = canAllocate ? (await client.query('SELECT user_id AS id, display_name AS name FROM laboratory_assignment_users() ORDER BY display_name,user_id')).rows : [];
  return { sample, users, canCreateJobs: canAllocate, rows: result.rows.map((row) => ({ ...row,
    canAllocate: canAllocate && row.status === 'created',
    canJoinJob: canAllocate && !row.isJob && !row.parentRequestId && row.status === 'created' && !row.hasAnalyst })) };
}

export async function allocationOptions(client, identity, requestId) {
  requirePermission(identity, 'test_requests.allocate'); uuid(requestId, 'Test request');
  const record = (await client.query(`SELECT specification.test_parameter_id AS "parameterId", specification.method_id AS "methodId", product.product_id AS "productId"
    FROM test_requests request LEFT JOIN analytical_specifications specification ON specification.organization_id=request.organization_id AND specification.id=request.specification_id
    JOIN laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    WHERE request.organization_id=$1 AND request.id=$2`, [identity.organization_id, requestId])).rows[0];
  if (!record) throw new HttpError(404, 'test_request_not_found', 'Test request was not found.');
  const users = await client.query('SELECT user_id AS id, display_name AS name FROM laboratory_assignment_users()');
  // Workload counts come from actual current assignments. Qualification and
  // leave adapters remain separate; absence here is never labelled valid/no.
  const counts = await client.query(`SELECT assignment.assigned_user_id AS id, count(*)::integer AS "workload",
    count(*) FILTER (WHERE specification.test_parameter_id=$2 AND specification.method_id=$3 AND product.product_id=$4)::integer AS "parameterWorkload"
    FROM test_request_assignments assignment JOIN test_requests request ON request.organization_id=assignment.organization_id AND request.id=assignment.test_request_id
    LEFT JOIN analytical_specifications specification ON specification.organization_id=request.organization_id AND specification.id=request.specification_id
    JOIN laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    LEFT JOIN workflow_runs run ON run.organization_id=request.organization_id AND run.test_request_id=request.id
    LEFT JOIN workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE assignment.organization_id=$1 AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
      AND request.status IN ('allocated','in_progress','under_review') AND coalesce(state.state_type, 'initial') NOT IN ('final','cancelled')
    GROUP BY assignment.assigned_user_id`, [identity.organization_id, record.parameterId, record.methodId, record.productId]);
  const byId = new Map(counts.rows.map((row) => [row.id, row]));
  return { users: users.rows.map((user) => ({ ...user, workload: byId.get(user.id)?.workload ?? 0, parameterWorkload: byId.get(user.id)?.parameterWorkload ?? 0 })) };
}
