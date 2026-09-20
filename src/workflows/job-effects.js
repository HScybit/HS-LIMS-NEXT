// These are actual parent events applied to a covered child submission. They
// are displayed as parent events, never rewritten as independent child history.
export async function loadJobWorkflowEffects(client, identity, requestId) {
  if (!requestId) return [];
  return (await client.query(`SELECT id,action,actor_user_id AS "actorUserId",comment,occurred_at AS "occurredAt",
    target_state_name AS "toStateName",source_state_name AS "fromStateName",transition_id AS "transitionId",
    parent_history_id AS "parentHistoryId",parent_workflow_run_id AS "parentWorkflowRunId",parent_request_id AS "parentRequestId",
    parent_job_number AS "parentJobNumber",parent_run_revision AS "parentRunRevision",target_state_type AS "targetStateType",target_color AS color,is_current AS "isCurrent"
    FROM laboratory_job_workflow_effects WHERE organization_id=$1 AND test_request_id=$2 ORDER BY parent_run_revision DESC LIMIT 100`, [identity.organization_id, requestId])).rows;
}
