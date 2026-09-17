import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, revision, text, bool, requirePermission } from '../templates/input.js';
import { insertBatch } from '../templates/authoring.js';
import { workflowStateInput, workflowTransitionInput, stateRoles, stateLayoutDefaults } from './input.js';
import { loadWorkflowDefinition } from './definition.js';
import { buildWorkflowCloneRows } from './clone.js';
import { createWorkflowMaster } from './metadata.js';
import { transitionChecklist } from './checklists.js';
import { selectWorkflowTemplate } from './references.js';
import { workflowStatePatchInput, workflowTransitionPatchInput } from './patch-input.js';
import { workflowPublicationProblem } from './publication.js';
import * as w from '../db/workflow-schema.js';

const scope = (table, org, id) => and(eq(table.organizationId, org), eq(table.id, id));
const detailScope = (table, org, transitionId) => and(eq(table.organizationId, org), eq(table.transitionId, transitionId));
const detailTables = [w.workflowTransitionCreatorRoles, w.workflowTransitionApproverRoles, w.workflowTransitionCcRoles, w.workflowTransitionCcEmails, w.workflowTransitionConditions, w.workflowTransitionChecklistItems];

async function removeTransitionDefinitions(db, org, ids) {
  if (!ids.length) return;
  for (const table of detailTables) await db.delete(table).where(and(eq(table.organizationId, org), inArray(table.transitionId, ids)));
  await db.delete(w.workflowTransitions).where(and(eq(w.workflowTransitions.organizationId, org), inArray(w.workflowTransitions.id, ids)));
}

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
  const workflow = await client.query(`SELECT workflow.id FROM workflows workflow JOIN workflow_versions version
    ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
    WHERE version.organization_id=$1 AND version.id=$2 AND workflow.active FOR UPDATE OF workflow`, [identity.organization_id, versionId]);
  if (!workflow.rowCount) throw new HttpError(404, 'workflow_not_found', 'Workflow was not found.');
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

export async function requireWorkflowAuthor(client, identity) {
  requirePermission(identity, 'workflows.manage');
  // This application-callable scope validates the current session, credentials,
  // membership and tenant. Recheck management permission after the lock wait.
  const result = await client.query(`SELECT public.workflow_reference_organization()=$1::uuid
    AND nullif(current_setting('app.user_id',true),'')::uuid=$2::uuid
    AND public.app_has_permission('workflows.manage') AS allowed`, [identity.organization_id, identity.user_id]);
  if (!result.rows[0]?.allowed) throw new HttpError(403, 'forbidden', 'Your workflow management access changed. Sign in again before saving.');
}

async function lockPatch(client, identity, versionId, expected) {
  await lockDraft(client, identity, versionId, expected);
  await requireWorkflowAuthor(client, identity);
}

async function removeUnusedPorts(client, db, org, versionId, id, existing, value) {
  if (value.inputCount < (existing.inputCount ?? 1) || value.outputCount < (existing.outputCount ?? 1)) {
    const removed = await client.query(`SELECT id FROM workflow_transitions WHERE organization_id=$1 AND workflow_version_id=$2
      AND ((target_state_id=$3 AND coalesce(target_port,1)>$4) OR (source_state_id=$3 AND coalesce(source_port,1)>$5))`,
    [org, versionId, id, value.inputCount ?? existing.inputCount ?? 1, value.outputCount ?? existing.outputCount ?? 1]);
    await removeTransitionDefinitions(db, org, removed.rows.map((transition) => transition.id));
  }
}

export async function patchWorkflowState(client, identity, versionId, expected, stateId, input) {
  uuid(stateId, 'State'); const org = identity.organization_id;
  return mutation(async () => {
    await lockPatch(client, identity, versionId, expected); const db = database(client);
    const [existing] = await db.select().from(w.workflowStates).where(and(scope(w.workflowStates, org, stateId), eq(w.workflowStates.workflowVersionId, versionId)));
    if (!existing) throw new HttpError(404, 'workflow_state_not_found', 'State was not found in this workflow version.');
    const value = workflowStatePatchInput(existing, input);
    const families = Object.keys(stateRoles).filter((field) => Object.hasOwn(value, field));
    await requireRoles(client, org, families.flatMap((field) => value[field]));
    if (value.templateId) await selectWorkflowTemplate(client, identity, value.templateId);
    await removeUnusedPorts(client, db, org, versionId, stateId, existing, value);
    for (const field of families) {
      const parameters = [org, stateId, stateRoles[field], value[field]];
      // Keep unchanged assignments intact; form saves may resubmit hundreds of
      // selected roles while changing only a name or one permission choice.
      await client.query(`DELETE FROM workflow_state_capability_roles WHERE organization_id=$1 AND workflow_state_id=$2
        AND capability=$3 AND NOT (role_id=ANY($4::uuid[]))`, parameters);
      if (value[field].length) await client.query(`INSERT INTO workflow_state_capability_roles(organization_id,workflow_state_id,capability,role_id)
        SELECT $1::uuid,$2::uuid,$3::text,desired.role_id FROM unnest($4::uuid[]) AS desired(role_id)
        WHERE NOT EXISTS (SELECT 1 FROM workflow_state_capability_roles existing WHERE existing.organization_id=$1
          AND existing.workflow_state_id=$2 AND existing.capability=$3 AND existing.role_id=desired.role_id)`, parameters);
      delete value[field];
    }
    if (Object.keys(value).length) await db.update(w.workflowStates).set(value).where(scope(w.workflowStates, org, stateId));
    return { id: stateId, revision: await nextRevision(client, org, versionId) };
  });
}

export async function patchWorkflowTransition(client, identity, versionId, expected, transitionId, input) {
  uuid(transitionId, 'Transition'); const org = identity.organization_id;
  return mutation(async () => {
    await lockPatch(client, identity, versionId, expected); const db = database(client);
    const [existing] = await db.select().from(w.workflowTransitions).where(and(scope(w.workflowTransitions, org, transitionId), eq(w.workflowTransitions.workflowVersionId, versionId)));
    if (!existing) throw new HttpError(404, 'workflow_transition_not_found', 'Transition was not found in this workflow version.');
    const stages = input?.approvalMode !== undefined && input?.approverStages === undefined
      ? (await client.query(`SELECT stage_number AS "stageNumber",array_agg(role_id ORDER BY role_id) AS "roleIds"
        FROM workflow_transition_approver_roles WHERE organization_id=$1 AND transition_id=$2 GROUP BY stage_number ORDER BY stage_number`, [org, transitionId])).rows : [];
    const value = workflowTransitionPatchInput(existing, input, stages);
    if (['sourceStateId', 'targetStateId', 'sourcePort', 'targetPort'].some((key) => Object.hasOwn(value, key))) {
      const next = { ...existing, ...value };
      const states = (await client.query('SELECT id,input_count,output_count FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2 AND id=ANY($3::uuid[])',
        [org, versionId, [next.sourceStateId, next.targetStateId]])).rows;
      if (states.length !== 2) throw new HttpError(422, 'invalid_workflow_state', 'Both states must belong to this workflow version.');
      if ((next.sourcePort ?? 1) > (states.find((state) => state.id === next.sourceStateId).output_count ?? 1)
        || (next.targetPort ?? 1) > (states.find((state) => state.id === next.targetStateId).input_count ?? 1)) {
        throw new HttpError(422, 'invalid_workflow_port', 'Select an available input and output port.');
      }
    }
    await requireRoles(client, org, [...(value.creatorRoleIds ?? []), ...(value.ccRoleIds ?? []), ...(value.approverStages ?? []).flatMap((stage) => stage.roleIds)]);
    if (Object.hasOwn(value, 'checklistMasterId')) {
      const selected = await transitionChecklist(client, identity, existing, { ...value, checklist: [] }, input);
      value.checklistMasterId = selected.checklistMasterId; value.checklistMasterRevision = selected.checklistMasterRevision;
      await db.delete(w.workflowTransitionChecklistItems).where(detailScope(w.workflowTransitionChecklistItems, org, transitionId));
      await insertBatch(db, w.workflowTransitionChecklistItems, selected.checklist.map((item) => ({ ...item, organizationId: org, transitionId })));
    }
    const base = { organizationId: org, transitionId };
    const families = [
      ['creatorRoleIds', w.workflowTransitionCreatorRoles, (roleId) => ({ ...base, roleId })],
      ['ccRoleIds', w.workflowTransitionCcRoles, (roleId) => ({ ...base, roleId })],
      ['ccEmails', w.workflowTransitionCcEmails, (email) => ({ ...base, email })],
      ['approverStages', w.workflowTransitionApproverRoles, (stage) => stage.roleIds.map((roleId) => ({ ...base, roleId, stageNumber: stage.stageNumber }))],
    ];
    for (const [field, table, record] of families) {
      if (!Object.hasOwn(value, field)) continue;
      await db.delete(table).where(detailScope(table, org, transitionId));
      await insertBatch(db, table, value[field].flatMap(record)); delete value[field];
    }
    if (Object.keys(value).length) await db.update(w.workflowTransitions).set(value).where(scope(w.workflowTransitions, org, transitionId));
    return { id: transitionId, revision: await nextRevision(client, org, versionId) };
  });
}

export async function createWorkflow(client, identity, input) {
  requirePermission(identity, 'workflows.manage'); fieldsOnly(input, ['code', 'name', 'description', 'appliesTo', 'active']);
  if (!['sample', 'test_request', 'instrument_service'].includes(input.appliesTo)) throw new HttpError(400, 'invalid_workflow_type', 'Select a supported workflow type.');
  return mutation(async () => {
    const saved = await createWorkflowMaster(client, identity, { ...input, id: randomUUID(), requestId: randomUUID(), metadataRevision: 0,
      code: text(input.code, 'Code', 64), active: bool(input.active ?? true, 'Active') });
    return { workflowId: saved.workflowId, versionId: saved.versionId, revision: saved.revision };
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
    if (value.templateId) await selectWorkflowTemplate(client, identity, value.templateId);
    const roles = [];
    for (const [field, capability] of Object.entries(stateRoles)) {
      roles.push(...value[field].map((roleId) => ({ organizationId: org, workflowStateId: stateId, capability, roleId }))); delete value[field];
    }
    value.displayOrder ??= existing?.displayOrder ?? (await client.query('SELECT coalesce(max(display_order), -1)+1 AS position FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2', [org, versionId])).rows[0].position;
    const id = stateId ?? randomUUID();
    if (existing) await removeUnusedPorts(client, db, org, versionId, id, existing, value);
    if (existing) await db.update(w.workflowStates).set(value).where(scope(w.workflowStates, org, id));
    else await db.insert(w.workflowStates).values({ ...stateLayoutDefaults, ...value, id, organizationId: org, workflowVersionId: versionId });
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
    const states = await client.query('SELECT id,input_count,output_count FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2 AND id=ANY($3::uuid[])', [org, versionId, [value.sourceStateId, value.targetStateId]]);
    if (states.rowCount !== 2) throw new HttpError(422, 'invalid_workflow_state', 'Both states must belong to this workflow version.');
    const sourcePort = value.sourcePort === undefined ? (existing ? existing.sourcePort : 1) : value.sourcePort;
    const targetPort = value.targetPort === undefined ? (existing ? existing.targetPort : 1) : value.targetPort;
    if ((sourcePort ?? 1) > (states.rows.find((state) => state.id === value.sourceStateId).output_count ?? 1)
      || (targetPort ?? 1) > (states.rows.find((state) => state.id === value.targetStateId).input_count ?? 1)) {
      throw new HttpError(422, 'invalid_workflow_port', 'Select an available input and output port.');
    }
    await requireRoles(client, org, [...value.creatorRoleIds, ...value.ccRoleIds, ...value.approverStages.flatMap((stage) => stage.roleIds)]);
    const selectedChecklist = await transitionChecklist(client, identity, existing, value, input);
    value.checklist = selectedChecklist.checklist;
    let autoMoveMode = existing?.autoMoveMode ?? null; let autoExecute = existing?.autoExecute ?? false;
    // The source editor can send its previous boolean alongside a changed mode.
    if (value.autoMoveMode !== undefined) { autoMoveMode = value.autoMoveMode; autoExecute = autoMoveMode === 'yes'; }
    else if (input.autoExecute !== undefined) {
      autoExecute = value.autoExecute;
      if (!existing || autoExecute !== existing.autoExecute) autoMoveMode = autoExecute ? 'yes' : 'no';
    } else if (!existing) autoMoveMode = 'no';
    const id = transitionId ?? randomUUID();
    const metadata = { code: value.code, name: value.name, sourceStateId: value.sourceStateId, targetStateId: value.targetStateId,
      sourcePort, targetPort,
      checklistMasterId: selectedChecklist.checklistMasterId, checklistMasterRevision: selectedChecklist.checklistMasterRevision,
      approvalMode: value.approvalMode, autoExecute, autoMoveMode, requireComment: value.requireComment,
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
      await removeTransitionDefinitions(db, org, connected);
      await db.delete(w.workflowStateCapabilityRoles).where(and(eq(w.workflowStateCapabilityRoles.organizationId, org), eq(w.workflowStateCapabilityRoles.workflowStateId, id)));
    } else for (const detail of detailTables) await db.delete(detail).where(detailScope(detail, org, id));
    await db.delete(table).where(scope(table, org, id));
    return { revision: await nextRevision(client, org, versionId) };
  });
}

async function saveWorkflowVersion(client, identity, versionId, expected, changeSummary, allowDraft) {
  const summary = text(changeSummary, 'Change summary', 2000);
  return mutation(async () => {
    const version = await lockDraft(client, identity, versionId, expected);
    await client.query('SELECT id FROM workflows WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, version.workflow_id]);
    const definition = await loadWorkflowDefinition(client, identity, versionId);
    const problem = workflowPublicationProblem(definition);
    if (problem) {
      if (!allowDraft) throw new HttpError(422, 'workflow_validation_failed', problem);
      const result = await client.query('UPDATE workflow_versions SET revision=revision+1,change_summary=$3 WHERE organization_id=$1 AND id=$2 RETURNING revision',
        [identity.organization_id, versionId, summary]);
      return { versionId, revision: result.rows[0].revision, status: 'draft' };
    }
    await client.query("UPDATE workflow_versions SET status='retired', retired_at=now(), revision=revision+1 WHERE organization_id=$1 AND workflow_id=$2 AND status='published'", [identity.organization_id, version.workflow_id]);
    const result = await client.query("UPDATE workflow_versions SET status='published', revision=revision+1, published_by=$3, published_at=now(), change_summary=$4 WHERE organization_id=$1 AND id=$2 RETURNING revision", [identity.organization_id, versionId, identity.user_id, summary]);
    return { versionId, revision: result.rows[0].revision, status: 'published' };
  });
}

export const publishWorkflow = (client, identity, versionId, expected, changeSummary) =>
  saveWorkflowVersion(client, identity, versionId, expected, changeSummary, false);

export const saveWorkflowFlow = (client, identity, versionId, expected, changeSummary) =>
  saveWorkflowVersion(client, identity, versionId, expected, changeSummary, true);

export async function cloneWorkflowDraft(client, identity, versionId) {
  requirePermission(identity, 'workflows.manage'); uuid(versionId, 'Workflow version');
  return mutation(async () => {
    const org = identity.organization_id; const db = database(client);
    const workflow = await client.query(`SELECT workflow.id FROM workflows workflow JOIN workflow_versions version
      ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id
      WHERE version.organization_id=$1 AND version.id=$2 AND workflow.active FOR UPDATE OF workflow`, [org, versionId]);
    if (!workflow.rowCount) throw new HttpError(404, 'workflow_not_found', 'Workflow was not found.');
    await client.query('SELECT id FROM workflow_versions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, versionId]);
    const current = await loadWorkflowDefinition(client, identity, versionId);
    const versions = await client.query('SELECT number, status FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2', [org, current.workflow.id]);
    if (versions.rows.some((version) => version.status === 'draft')) throw new HttpError(409, 'workflow_draft_exists', 'This workflow already has an editable draft.');
    const [draft] = await db.insert(w.workflowVersions).values({ organizationId: org, workflowId: current.workflow.id, number: Math.max(...versions.rows.map((version) => version.number)) + 1, createdBy: identity.user_id, changeSummary: `Draft from version ${current.version.number}` }).returning();
    const rows = buildWorkflowCloneRows(current, draft.id);
    for (const [table, records] of [[w.workflowStates, rows.states], [w.workflowStateCapabilityRoles, rows.stateRoles],
      [w.workflowTransitions, rows.transitions], [w.workflowTransitionCreatorRoles, rows.creatorRoles], [w.workflowTransitionApproverRoles, rows.approverRoles],
      [w.workflowTransitionCcRoles, rows.ccRoles], [w.workflowTransitionCcEmails, rows.emails], [w.workflowTransitionConditions, rows.conditions],
      [w.workflowTransitionChecklistItems, rows.checklist]]) await insertBatch(db, table, records);
    return { workflowId: current.workflow.id, versionId: draft.id, revision: 1 };
  });
}
