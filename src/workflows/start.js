import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { workflowRuns, workflowRunHistory } from '../db/sample-schema.js';

// Called inside registration/allocation transactions after their domain permission
// checks. New samples use the source organization configuration. Existing TR
// category/default behavior is handled separately from this sample boundary.
export async function startWorkflow(client, identity, owner, sampleCategoryId, { workflowId = null } = {}) {
  const result = await client.query(`WITH configured AS MATERIALIZED (
      SELECT CASE WHEN $3='sample' THEN public.laboratory_sample_workflow($5::uuid)
        ELSE coalesce($4::uuid,(SELECT mapping.workflow_id FROM sample_category_workflows mapping
          WHERE mapping.organization_id=$1 AND mapping.sample_category_id=$2 AND mapping.applies_to=$3 AND mapping.is_default)) END AS id
    ) SELECT version.id AS version_id, state.id AS state_id, state.generate_test_requests
    FROM workflows workflow
    JOIN configured ON configured.id=workflow.id
    JOIN workflow_versions version ON version.organization_id = workflow.organization_id AND version.workflow_id = workflow.id AND version.status = 'published'
    JOIN workflow_states state ON state.organization_id = version.organization_id AND state.workflow_version_id = version.id AND state.state_type = 'initial'
    WHERE workflow.organization_id=$1 AND workflow.active AND workflow.applies_to=$3
    ORDER BY version.number DESC LIMIT 1`, [identity.organization_id, sampleCategoryId, owner.type, workflowId, owner.id]);
  if (!result.rowCount) {
    if (owner.type === 'sample') throw new HttpError(422, 'sample_workflow_not_configured', 'Configure an active published workflow for this sample type in Organization Settings > Workflow Configs.');
    if (workflowId) throw new HttpError(422, 'job_workflow_unavailable', 'The configured job workflow is unavailable. Select a published workflow in Organization Settings.');
    return null;
  }
  const initial = result.rows[0];
  const db = database(client);
  const [run] = await db.insert(workflowRuns).values({ organizationId: identity.organization_id, workflowVersionId: initial.version_id,
    ...(owner.type === 'sample' ? { sampleId: owner.id } : { testRequestId: owner.id }), currentStateId: initial.state_id, startedBy: identity.user_id }).returning();
  await db.insert(workflowRunHistory).values({ organizationId: identity.organization_id, workflowRunId: run.id, workflowVersionId: initial.version_id,
    toStateId: initial.state_id, action: 'started', actorUserId: identity.user_id });
  return { id: run.id, versionId: initial.version_id, stateId: initial.state_id, generateTestRequests: initial.generate_test_requests };
}
