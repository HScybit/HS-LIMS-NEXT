import { randomUUID } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, requirePermission } from '../templates/input.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { allocateTestRequest, initializeGeneratedRequest } from './allocate.js';

function jobInput(input) {
  fieldsOnly(input, ['requestIds', 'analystUserId', 'reviewerUserId']);
  if (!Array.isArray(input.requestIds) || input.requestIds.length < 1 || input.requestIds.length > 500) {
    throw new HttpError(400, 'invalid_job_selection', 'Select between 1 and 500 test requests.');
  }
  const requestIds = input.requestIds.map((id) => uuid(id, 'Test request').toLowerCase());
  if (new Set(requestIds).size !== requestIds.length) throw new HttpError(400, 'duplicate_job_selection', 'Select each test request once.');
  const analystUserId = uuid(input.analystUserId, 'Assignee').toLowerCase();
  const reviewerUserId = input.reviewerUserId == null ? null : uuid(input.reviewerUserId, 'Reviewer').toLowerCase();
  if (analystUserId === reviewerUserId) throw new HttpError(422, 'allocation_role_conflict', 'Assignee and reviewer cannot be the same.');
  return { requestIds, analystUserId, reviewerUserId };
}

export async function createAutomaticJobs(client, identity, sampleId, requests) {
  const settings = (await client.query('SELECT * FROM laboratory_generation_job_settings($1)', [sampleId])).rows[0];
  if (!settings?.auto_create_jobs || !settings.result_summary_template_id) return { jobs: [], members: new Map() };
  const groups = new Map();
  for (const request of requests) {
    if (!groups.has(request.sampleProductId)) groups.set(request.sampleProductId, []);
    groups.get(request.sampleProductId).push(request.id);
  }
  const jobs = []; const members = new Map();
  for (const requestIds of groups.values()) {
    const job = (await client.query('SELECT * FROM laboratory_start_auto_job($1::uuid[])', [requestIds])).rows[0];
    for (const requestId of requestIds) {
      await client.query("SELECT set_config('app.auto_job_request_id',$1,true)", [requestId]);
      members.set(requestId, await initializeGeneratedRequest(client, identity, requestId));
    }
    jobs.push({ id: job.id, requestNumber: job.request_number, memberCount: job.member_count, datasheetId: null, workflowRunId: null });
  }
  // A failed command rolls back its withSession transaction and local context.
  // Do not mask a PostgreSQL failure with cleanup in an aborted transaction.
  await client.query("SELECT set_config('app.auto_job_request_id','',true)");
  return { jobs, members };
}

export async function createTestRequestJobs(client, identity, rawInput) {
  requirePermission(identity, 'test_requests.allocate');
  const input = jobInput(rawInput); const org = identity.organization_id;
  const sampleIds = (await client.query(`SELECT DISTINCT sample_id FROM laboratory_test_request_context
    WHERE organization_id=$1 AND test_request_id=ANY($2::uuid[])`, [org, input.requestIds])).rows;
  if (!sampleIds.length) throw new HttpError(409, 'test_request_not_available', 'The selected test requests are unavailable.');
  if (sampleIds.length !== 1) throw new HttpError(422, 'job_sample_mismatch', 'A job can contain test requests from only one sample.');
  const sampleId = sampleIds[0].sample_id;
  await client.query('SELECT laboratory_lock_sample($1)', [sampleId]);
  const selected = (await client.query(`SELECT request.id,request.revision,request.priority,context.sample_product_id,context.sample_category_id,
    EXISTS (SELECT 1 FROM sample_category_workflows mapping JOIN workflows workflow
      ON workflow.organization_id=mapping.organization_id AND workflow.id=mapping.workflow_id AND workflow.active
      JOIN workflow_versions version ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published'
      WHERE mapping.organization_id=request.organization_id AND mapping.sample_category_id=context.sample_category_id AND mapping.applies_to='test_request' AND mapping.is_default) AS uses_dynamic_workflow
    FROM test_requests request JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
    JOIN sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    WHERE request.organization_id=$1 AND request.id=ANY($2::uuid[]) AND NOT request.is_job AND request.parent_test_request_id IS NULL AND request.status='created'
      AND NOT EXISTS (SELECT 1 FROM test_request_assignments assignment WHERE assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id
        AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL)
    ORDER BY context.sample_product_id,selected.display_order,request.id FOR UPDATE OF request`, [org, input.requestIds])).rows;
  if (selected.length !== input.requestIds.length) throw new HttpError(409, 'test_request_not_available', 'Select unallocated test requests that are not already part of a job.');
  await requireWorkflowAction(client, identity, { type: 'sample', id: sampleId }, 'allocate');
  if (!input.reviewerUserId && selected.some((request) => !request.uses_dynamic_workflow)) {
    throw new HttpError(422, 'job_reviewer_required', 'Select a reviewer for test requests without a dynamic workflow.');
  }
  const assigneeIds = [input.analystUserId, input.reviewerUserId].filter(Boolean);
  if ((await client.query('SELECT user_id FROM laboratory_assignment_users() WHERE user_id=ANY($1::uuid[])', [assigneeIds])).rowCount !== assigneeIds.length) {
    throw new HttpError(422, 'invalid_assignee', 'Select active assignees from this organization.');
  }
  const settings = (await client.query('SELECT * FROM laboratory_job_settings()')).rows[0];
  if (!settings?.result_summary_template_id) throw new HttpError(422, 'job_template_not_configured', 'Select a Test Result Summary Template in Organization Settings.');
  const groups = new Map();
  for (const request of selected) {
    if (!groups.has(request.sample_product_id)) groups.set(request.sample_product_id, []);
    groups.get(request.sample_product_id).push(request);
  }
  const items = [];
  for (const [productLineId, members] of groups) {
    const jobId = randomUUID(); const memberIds = members.map((request) => request.id);
    const number = (await client.query("SELECT laboratory_next_number('job',extract(year FROM now() AT TIME ZONE 'UTC')::integer::text) AS number")).rows[0].number;
    const priority = members.some((row) => row.priority === 'urgent') ? 'urgent' : members.some((row) => row.priority === 'high') ? 'high' : members[0].priority;
    // Preserve PostgreSQL timestamp precision when deriving the earliest due date.
    await client.query(`INSERT INTO test_requests(organization_id,id,request_number,is_job,job_sample_product_id,priority,due_at,datasheet_template_id,created_by)
      SELECT $1,$2,$3,true,$4,$5,min(due_at),$6,$7 FROM test_requests WHERE organization_id=$1 AND id=ANY($8::uuid[])`,
    [org, jobId, number, productLineId, priority, settings.result_summary_template_id, identity.user_id, memberIds]);
    await client.query(`UPDATE test_requests request SET parent_test_request_id=$3,job_member_position=member.ordinality-1,job_linked_by=$4,
      job_linked_at=now(),revision=request.revision+1 FROM unnest($2::uuid[]) WITH ORDINALITY member(id,ordinality)
      WHERE request.organization_id=$1 AND request.id=member.id`, [org, memberIds, jobId, identity.user_id]);
    for (const member of members) {
      const allocated = await allocateTestRequest(client, identity, member.id, { revision: member.revision + 1, assignmentType: 'analyst', assignedUserId: input.analystUserId });
      if (input.reviewerUserId) await allocateTestRequest(client, identity, member.id, { revision: allocated.revision, assignmentType: 'reviewer', assignedUserId: input.reviewerUserId });
    }
    const allocated = await allocateTestRequest(client, identity, jobId, { revision: 1, assignmentType: 'analyst', assignedUserId: input.analystUserId });
    const final = input.reviewerUserId ? await allocateTestRequest(client, identity, jobId, { revision: allocated.revision, assignmentType: 'reviewer', assignedUserId: input.reviewerUserId }) : allocated;
    items.push({ id: jobId, requestNumber: number, sampleId, memberCount: members.length, revision: final.revision,
      datasheetId: allocated.datasheetId, workflowRunId: allocated.workflowRunId });
  }
  return { items };
}
