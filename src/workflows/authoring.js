import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, revision, text, bool, requirePermission } from '../templates/input.js';
import { insertBatch } from '../templates/authoring.js';
import { workflowStateInput, workflowTransitionInput, stateRoles } from './input.js';
import { loadWorkflowDefinition } from './definition.js';
import * as w from '../db/workflow-schema.js';

const scope = (table, org, id) => and(eq(table.organizationId, org), eq(table.id, id));
const detailScope = (table, org, transitionId) => and(eq(table.organizationId, org), eq(table.transitionId, transitionId));
const detailTables = [w.workflowTransitionCreatorRoles, w.workflowTransitionApproverRoles, w.workflowTransitionCcRoles, w.workflowTransitionCcEmails, w.workflowTransitionConditions, w.workflowTransitionChecklistItems];

async function mutation(work) {
  try { return await work(); }
  catch (failure) {
    const code = (failure.cause ?? failure).code;
    if (code === '23505') throw new HttpError(409, 'workflow_duplicate', 'This workflow code, state type or identity is already in use.');
    if (['23503', '23514'].includes(code)) throw new HttpError(422, 'invalid_workflow_definition', 'The workflow contains an invalid state, role, reference or approval configuration.');
    throw failure;
  }
}
async function lockDraft(client, identity, versionId, expected) {
  requirePermission(identity, 'workflows.manage'); uuid(versionId, 'Workflow version'); revision(expected);
  await client.query(`SELECT workflow.id FROM workflows workflow JOIN workflow_versions version
    ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
    WHERE version.organization_id=$1 AND version.id=$2 FOR UPDATE OF workflow`, [identity.organization_id, versionId]);
  const result = await client.query('SELECT * FROM workflow_versions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, versionId]);
  const version = result.rows[0];
  if (!version) throw new HttpError(404, 'workflow_not_found', 'Workflow version was not found.');
  if (version.status !== 'draft' || version.revision !== expected) throw new HttpError(409, 'stale_workflow_definition', 'This workflow changed or was published. Reload before saving.');
  return version;
}
async function nextRevision(client, org, versionId) {
  return (await client.query('UPDATE workflow_versions SET revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING revision', [org, versionId])).rows[0].revision;
}
async function requireRoles(client, org, roleIds) {
  const distinct = [...new Set(roleIds)];
  if (!distinct.length) return;
  const result = await client.query('SELECT id FROM roles WHERE organization_id=$1 AND active AND id=ANY($2::uuid[])', [org, distinct]);
  if (result.rowCount !== distinct.length) throw new HttpError(422, 'invalid_workflow_role', 'A selected role is unavailable in this organization.');
}

export async function createWorkflow(client, identity, input) {
  requirePermission(identity, 'workflows.manage'); fieldsOnly(input, ['code', 'name', 'description', 'appliesTo', 'active']);
  if (!['sample', 'test_request'].includes(input.appliesTo)) throw new HttpError(400, 'invalid_workflow_type', 'Select a supported workflow type.');
  const record = { organizationId: identity.organization_id, code: text(input.code, 'Code', 64), name: text(input.name, 'Name'),
    description: text(input.description, 'Description', 10000, { optional: true }), appliesTo: input.appliesTo, active: bool(input.active ?? true, 'Active') };
  return mutation(async () => {
    const db = database(client); const [workflow] = await db.insert(w.workflows).values(record).returning();
    const [version] = await db.insert(w.workflowVersions).values({ organizationId: identity.organization_id, workflowId: workflow.id, number: 1, createdBy: identity.user_id, changeSummary: 'Initial draft' }).returning();
    return { workflowId: workflow.id, versionId: version.id, revision: version.revision };
  });
}

export async function saveWorkflowState(client, identity, versionId, expected, input, stateId = null) {
  const value = workflowStateInput(input); const org = identity.organization_id;
  if (stateId) uuid(stateId, 'State');
  return mutation(async () => {
    await lockDraft(client, identity, versionId, expected);
    const db = database(client);
    const existing = stateId ? (await db.select().from(w.workflowStates).where(and(scope(w.workflowStates, org, stateId), eq(w.workflowStates.workflowVersionId, versionId))))[0] : null;
    if (stateId && !existing) throw new HttpError(404, 'workflow_state_not_found', 'State was not found in this workflow version.');
    await requireRoles(client, org, Object.keys(stateRoles).flatMap((field) => value[field]));
    if (value.templateId && !(await client.query('SELECT id FROM templates WHERE organization_id=$1 AND id=$2 AND active', [org, value.templateId])).rowCount) {
      throw new HttpError(422, 'invalid_workflow_template', 'The selected template is inactive or unavailable.');
    }
    const roles = [];
    for (const [field, capability] of Object.entries(stateRoles)) {
      roles.push(...value[field].map((roleId) => ({ organizationId: org, workflowStateId: stateId, capability, roleId }))); delete value[field];
    }
    value.displayOrder ??= existing?.displayOrder ?? (await client.query('SELECT coalesce(max(display_order), -1)+1 AS position FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2', [org, versionId])).rows[0].position;
    const id = stateId ?? randomUUID();
    if (existing) await db.update(w.workflowStates).set(value).where(scope(w.workflowStates, org, id));
    else await db.insert(w.workflowStates).values({ ...value, id, organizationId: org, workflowVersionId: versionId });
    await db.delete(w.workflowStateCapabilityRoles).where(and(eq(w.workflowStateCapabilityRoles.organizationId, org), eq(w.workflowStateCapabilityRoles.workflowStateId, id)));
    await insertBatch(db, w.workflowStateCapabilityRoles, roles.map((role) => ({ ...role, workflowStateId: id })));
    return { id, revision: await nextRevision(client, org, versionId) };
  });
}

async function writeTransitionDetails(client, org, transitionId, value, existing) {
  const db = database(client);
  for (const [table, records] of [[w.workflowTransitionConditions, value.conditions], [w.workflowTransitionChecklistItems, value.checklist]]) {
    const supplied = records.flatMap((record) => record.id ? [record.id] : []);
    if (supplied.length) {
      const known = existing ? await db.select({ id: table.id }).from(table).where(and(detailScope(table, org, transitionId), inArray(table.id, supplied))) : [];
      if (known.length !== supplied.length) throw new HttpError(422, 'invalid_workflow_detail', 'A checklist item or condition does not belong to this transition.');
    }
  }
  for (const table of detailTables) await db.delete(table).where(detailScope(table, org, transitionId));
  const base = { organizationId: org, transitionId };
  await insertBatch(db, w.workflowTransitionCreatorRoles, value.creatorRoleIds.map((roleId) => ({ ...base, roleId })));
  await insertBatch(db, w.workflowTransitionApproverRoles, value.approverStages.flatMap((stage) => stage.roleIds.map((roleId) => ({ ...base, roleId, stageNumber: stage.stageNumber }))));
  await insertBatch(db, w.workflowTransitionCcRoles, value.ccRoleIds.map((roleId) => ({ ...base, roleId })));
  await insertBatch(db, w.workflowTransitionCcEmails, value.ccEmails.map((email) => ({ ...base, email })));
  await insertBatch(db, w.workflowTransitionConditions, value.conditions.map((condition) => ({ ...base, ...condition })));
  await insertBatch(db, w.workflowTransitionChecklistItems, value.checklist.map((item) => ({ ...base, ...item })));
}

export async function saveWorkflowTransition(client, identity, versionId, expected, input, transitionId = null) {
  const value = workflowTransitionInput(input); const org = identity.organization_id;
  if (transitionId) uuid(transitionId, 'Transition');
  return mutation(async () => {
    await lockDraft(client, identity, versionId, expected); const db = database(client);
    const existing = transitionId ? (await db.select().from(w.workflowTransitions).where(and(scope(w.workflowTransitions, org, transitionId), eq(w.workflowTransitions.workflowVersionId, versionId))))[0] : null;
    if (transitionId && !existing) throw new HttpError(404, 'workflow_transition_not_found', 'Transition was not found in this workflow version.');
    const states = await client.query('SELECT id FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2 AND id=ANY($3::uuid[])', [org, versionId, [value.sourceStateId, value.targetStateId]]);
    if (states.rowCount !== 2) throw new HttpError(422, 'invalid_workflow_state', 'Both states must belong to this workflow version.');
    await requireRoles(client, org, [...value.creatorRoleIds, ...value.ccRoleIds, ...value.approverStages.flatMap((stage) => stage.roleIds)]);
    const id = transitionId ?? randomUUID();
    const metadata = { code: value.code, name: value.name, sourceStateId: value.sourceStateId, targetStateId: value.targetStateId,
      approvalMode: value.approvalMode, autoExecute: value.autoExecute, requireComment: value.requireComment,
      displayOrder: value.displayOrder ?? existing?.displayOrder ?? (await client.query('SELECT coalesce(max(display_order), -1)+1 AS position FROM workflow_transitions WHERE organization_id=$1 AND workflow_version_id=$2', [org, versionId])).rows[0].position };
    if (existing) await db.update(w.workflowTransitions).set(metadata).where(scope(w.workflowTransitions, org, id));
    else await db.insert(w.workflowTransitions).values({ ...metadata, id, organizationId: org, workflowVersionId: versionId });
    await writeTransitionDetails(client, org, id, value, existing);
    return { id, revision: await nextRevision(client, org, versionId) };
  });
}

export async function deleteWorkflowElement(client, identity, versionId, expected, { type, id }) {
  uuid(id, 'Workflow element');
  if (!['state', 'transition'].includes(type)) throw new HttpError(400, 'invalid_workflow_input', 'Select a state or transition.');
  return mutation(async () => {
    await lockDraft(client, identity, versionId, expected); const db = database(client); const org = identity.organization_id;
    const table = type === 'state' ? w.workflowStates : w.workflowTransitions;
    if (!(await db.select({ id: table.id }).from(table).where(and(scope(table, org, id), eq(table.workflowVersionId, versionId)))).length) throw new HttpError(404, 'workflow_element_not_found', 'The workflow element was not found.');
    if (type === 'state') {
      const connected = (await client.query('SELECT id FROM workflow_transitions WHERE organization_id=$1 AND workflow_version_id=$2 AND (source_state_id=$3 OR target_state_id=$3)', [org, versionId, id])).rows.map((transition) => transition.id);
      for (const detail of detailTables) await db.delete(detail).where(and(eq(detail.organizationId, org), inArray(detail.transitionId, connected)));
      await db.delete(w.workflowTransitions).where(and(eq(w.workflowTransitions.organizationId, org), inArray(w.workflowTransitions.id, connected)));
      await db.delete(w.workflowStateCapabilityRoles).where(and(eq(w.workflowStateCapabilityRoles.organizationId, org), eq(w.workflowStateCapabilityRoles.workflowStateId, id)));
    } else for (const detail of detailTables) await db.delete(detail).where(detailScope(detail, org, id));
    await db.delete(table).where(scope(table, org, id));
    return { revision: await nextRevision(client, org, versionId) };
  });
}

export async function publishWorkflow(client, identity, versionId, expected, changeSummary) {
  const summary = text(changeSummary, 'Change summary', 2000);
  return mutation(async () => {
    const version = await lockDraft(client, identity, versionId, expected);
    await client.query('SELECT id FROM workflows WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, version.workflow_id]);
    const definition = await loadWorkflowDefinition(client, identity, versionId);
    if (definition.states.filter((state) => state.stateType === 'initial').length !== 1 || definition.states.filter((state) => state.stateType === 'final').length !== 1
      || definition.states.some((state) => ['initial', 'normal'].includes(state.stateType) && !definition.transitions.some((transition) => transition.sourceStateId === state.id))) {
      throw new HttpError(422, 'workflow_validation_failed', 'Add exactly one initial and final state, and connect every initial or normal state.');
    }
    await client.query("UPDATE workflow_versions SET status='retired', retired_at=now(), revision=revision+1 WHERE organization_id=$1 AND workflow_id=$2 AND status='published'", [identity.organization_id, version.workflow_id]);
    const result = await client.query("UPDATE workflow_versions SET status='published', revision=revision+1, published_by=$3, published_at=now(), change_summary=$4 WHERE organization_id=$1 AND id=$2 RETURNING revision", [identity.organization_id, versionId, identity.user_id, summary]);
    return { versionId, revision: result.rows[0].revision, status: 'published' };
  });
}

export async function cloneWorkflowDraft(client, identity, versionId) {
  requirePermission(identity, 'workflows.manage'); uuid(versionId, 'Workflow version');
  return mutation(async () => {
    const org = identity.organization_id; const db = database(client);
    await client.query(`SELECT workflow.id FROM workflows workflow JOIN workflow_versions version
      ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
      WHERE version.organization_id=$1 AND version.id=$2 FOR UPDATE OF workflow`, [org, versionId]);
    await client.query('SELECT id FROM workflow_versions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, versionId]);
    const current = await loadWorkflowDefinition(client, identity, versionId);
    const versions = await client.query('SELECT number, status FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2', [org, current.workflow.id]);
    if (versions.rows.some((version) => version.status === 'draft')) throw new HttpError(409, 'workflow_draft_exists', 'This workflow already has an editable draft.');
    const [draft] = await db.insert(w.workflowVersions).values({ organizationId: org, workflowId: current.workflow.id, number: Math.max(...versions.rows.map((version) => version.number)) + 1, createdBy: identity.user_id, changeSummary: `Draft from version ${current.version.number}` }).returning();
    const states = new Map(current.states.map((state) => [state.id, randomUUID()]));
    await insertBatch(db, w.workflowStates, current.states.map(({ capabilityRoles: _capabilities, ...state }) => ({ ...state, id: states.get(state.id), workflowVersionId: draft.id })));
    await insertBatch(db, w.workflowStateCapabilityRoles, current.states.flatMap((state) => state.capabilityRoles.map((role) => ({ ...role, organizationId: org, workflowStateId: states.get(state.id) }))));
    for (const transition of current.transitions) {
      const { creatorRoleIds, ccRoleIds, approverStages, conditions, checklist, ccEmails, ...metadata } = transition;
      const id = randomUUID();
      await db.insert(w.workflowTransitions).values({ ...metadata, id, workflowVersionId: draft.id, sourceStateId: states.get(transition.sourceStateId), targetStateId: states.get(transition.targetStateId) });
      await writeTransitionDetails(client, org, id, { creatorRoleIds, ccRoleIds, approverStages, ccEmails,
        conditions: conditions.map(({ id: _id, ...condition }) => ({ ...condition, transitionId: id })), checklist: checklist.map(({ id: _id, ...item }) => ({ ...item, transitionId: id })) }, false);
    }
    return { workflowId: current.workflow.id, versionId: draft.id, revision: 1 };
  });
}
