import { and, asc, eq, inArray } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import * as w from '../db/workflow-schema.js';

export async function loadWorkflowDefinition(client, identity, versionId) {
  uuid(versionId, 'Workflow version');
  if (!['workflows.read', 'workflows.manage', 'samples.read', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view workflows.');
  }
  const db = database(client); const org = identity.organization_id;
  const [header] = await db.select({ version: w.workflowVersions, workflow: w.workflows }).from(w.workflowVersions).innerJoin(w.workflows,
    and(eq(w.workflows.organizationId, w.workflowVersions.organizationId), eq(w.workflows.id, w.workflowVersions.workflowId)))
    .where(and(eq(w.workflowVersions.organizationId, org), eq(w.workflowVersions.id, versionId)));
  if (!header) throw new HttpError(404, 'workflow_not_found', 'Workflow version was not found.');
  const states = await db.select().from(w.workflowStates).where(and(eq(w.workflowStates.organizationId, org), eq(w.workflowStates.workflowVersionId, versionId))).orderBy(asc(w.workflowStates.displayOrder), asc(w.workflowStates.id));
  const stateIds = states.map((state) => state.id);
  const capabilities = await db.select().from(w.workflowStateCapabilityRoles).where(and(eq(w.workflowStateCapabilityRoles.organizationId, org), inArray(w.workflowStateCapabilityRoles.workflowStateId, stateIds)));
  const transitions = await db.select().from(w.workflowTransitions).where(and(eq(w.workflowTransitions.organizationId, org), eq(w.workflowTransitions.workflowVersionId, versionId))).orderBy(asc(w.workflowTransitions.displayOrder), asc(w.workflowTransitions.id));
  const ids = transitions.map((transition) => transition.id);
  const roles = await client.query(`SELECT transition_id AS "transitionId", role_id AS "roleId", 'creator' AS type, NULL::integer AS "stageNumber"
    FROM workflow_transition_creator_roles WHERE organization_id=$1 AND transition_id=ANY($2::uuid[])
    UNION ALL SELECT transition_id, role_id, 'approver', stage_number FROM workflow_transition_approver_roles WHERE organization_id=$1 AND transition_id=ANY($2::uuid[])
    UNION ALL SELECT transition_id, role_id, 'cc', NULL::integer FROM workflow_transition_cc_roles WHERE organization_id=$1 AND transition_id=ANY($2::uuid[])`, [org, ids]);
  const conditions = await db.select().from(w.workflowTransitionConditions).where(and(eq(w.workflowTransitionConditions.organizationId, org), inArray(w.workflowTransitionConditions.transitionId, ids))).orderBy(asc(w.workflowTransitionConditions.displayOrder), asc(w.workflowTransitionConditions.id));
  const checklist = await db.select().from(w.workflowTransitionChecklistItems).where(and(eq(w.workflowTransitionChecklistItems.organizationId, org), inArray(w.workflowTransitionChecklistItems.transitionId, ids))).orderBy(asc(w.workflowTransitionChecklistItems.displayOrder), asc(w.workflowTransitionChecklistItems.id));
  const emails = await db.select().from(w.workflowTransitionCcEmails).where(and(eq(w.workflowTransitionCcEmails.organizationId, org), inArray(w.workflowTransitionCcEmails.transitionId, ids))).orderBy(asc(w.workflowTransitionCcEmails.email));
  const byState = new Map(states.map((state) => [state.id, { ...state, capabilityRoles: [] }]));
  const byTransition = new Map(transitions.map((transition) => [transition.id, { ...transition, creatorRoleIds: [], ccRoleIds: [], approverStages: [], conditions: [], checklist: [], ccEmails: [] }]));
  for (const capability of capabilities) byState.get(capability.workflowStateId).capabilityRoles.push({ capability: capability.capability, roleId: capability.roleId });
  const stages = new Map();
  for (const role of roles.rows) {
    const transition = byTransition.get(role.transitionId);
    if (role.type !== 'approver') transition[role.type === 'creator' ? 'creatorRoleIds' : 'ccRoleIds'].push(role.roleId);
    else {
      const key = `${role.transitionId}:${role.stageNumber}`;
      if (!stages.has(key)) { const stage = { stageNumber: role.stageNumber, roleIds: [] }; stages.set(key, stage); transition.approverStages.push(stage); }
      stages.get(key).roleIds.push(role.roleId);
    }
  }
  for (const condition of conditions) byTransition.get(condition.transitionId).conditions.push(condition);
  for (const item of checklist) byTransition.get(item.transitionId).checklist.push(item);
  for (const email of emails) byTransition.get(email.transitionId).ccEmails.push(email.email);
  for (const transition of byTransition.values()) transition.approverStages.sort((a, b) => a.stageNumber - b.stageNumber);
  return { ...header, states: [...byState.values()], transitions: [...byTransition.values()], metrics: { queryCount: 8 } };
}
