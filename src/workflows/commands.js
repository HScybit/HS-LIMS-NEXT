import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, text, uuid } from '../templates/input.js';
import { workflowEditorCommandInput } from './command-input.js';
import { requireWorkflowAuthor, cloneWorkflowDraft, saveWorkflowState, patchWorkflowState, saveWorkflowTransition,
  patchWorkflowTransition, deleteWorkflowElement, publishWorkflow, saveWorkflowFlow } from './authoring.js';

const stale = () => new HttpError(409, 'stale_workflow_definition', 'This workflow changed or was published. Reload before saving.');
const reused = () => new HttpError(409, 'save_request_reused', 'This request was already used for a different workflow change.');

function commandResult(receipt) {
  return { workflowId: receipt.workflow_id, versionId: receipt.workflow_version_id, revision: receipt.revision,
    status: receipt.operation === 'publish' ? 'published' : 'draft', ...(receipt.element_id ? { id: receipt.element_id } : {}) };
}

async function mapClonedIds(client, org, sourceVersionId, versionId, kind, ids) {
  const table = kind === 'state' ? 'workflow_states' : 'workflow_transitions';
  const selected = [...new Set(ids.map((id) => uuid(id, 'Workflow element').toLowerCase()))];
  if (!selected.length) return new Map();
  const rows = (await client.query(`SELECT original.id AS source_id,copy.id FROM ${table} original JOIN ${table} copy
    ON copy.organization_id=original.organization_id AND copy.code=original.code AND copy.workflow_version_id=$3
    WHERE original.organization_id=$1 AND original.workflow_version_id=$2 AND original.id=ANY($4::uuid[])`,
  [org, sourceVersionId, versionId, selected])).rows;
  if (rows.length !== selected.length) throw new HttpError(404, 'workflow_element_not_found', 'The workflow element was not found in this version.');
  return new Map(rows.map((row) => [row.source_id, row.id]));
}

export async function executeWorkflowEditorCommand(client, identity, workflowId, input) {
  requirePermission(identity, 'workflows.manage');
  const command = workflowEditorCommandInput(workflowId, input); const org = identity.organization_id;
  try {
    // Permit a completed exact retry after retirement, as the existing metadata
    // and clone commands do. New writes still require an active workflow.
    const master = (await client.query('SELECT id,active FROM workflows WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, command.workflowId])).rows[0];
    if (!master) throw new HttpError(404, 'workflow_not_found', 'Workflow was not found.');
    await requireWorkflowAuthor(client, identity);
    const receipt = (await client.query(`SELECT workflow_id,workflow_version_id,revision,operation,element_id,fingerprint,saved_by
      FROM workflow_editor_commands WHERE organization_id=$1 AND request_id=$2`, [org, command.requestId])).rows[0];
    if (receipt) {
      if (receipt.workflow_id !== command.workflowId || receipt.saved_by !== identity.user_id || !receipt.fingerprint.equals(command.fingerprint)) throw reused();
      return commandResult(receipt);
    }
    if (!master.active) throw new HttpError(404, 'workflow_not_found', 'Workflow was not found.');
    const source = (await client.query(`SELECT id,revision,status FROM workflow_versions
      WHERE organization_id=$1 AND workflow_id=$2 AND id=$3 FOR UPDATE`, [org, command.workflowId, command.versionId])).rows[0];
    if (!source) throw new HttpError(404, 'workflow_version_not_found', 'This workflow version was not found.');
    await requireWorkflowAuthor(client, identity);
    if (source.revision !== command.revision || !['draft', 'published'].includes(source.status)) throw stale();
    if (['publish', 'save_flow'].includes(command.operation) && source.status !== 'draft') throw stale();
    let versionId = source.id; let expected = source.revision; let elementId = command.elementId;
    let value = command.input;
    if (source.status === 'published') {
      const draft = await cloneWorkflowDraft(client, identity, source.id); versionId = draft.versionId; expected = draft.revision;
      if (elementId) {
        const kind = command.operation.endsWith('_state') ? 'state' : 'transition';
        elementId = (await mapClonedIds(client, org, source.id, versionId, kind, [elementId])).get(elementId);
      }
      if (value && command.operation.endsWith('_transition')) {
        const fields = ['sourceStateId', 'targetStateId'].filter((key) => Object.hasOwn(value, key));
        const mapped = await mapClonedIds(client, org, source.id, versionId, 'state', fields.map((key) => value[key]));
        value = { ...value, ...Object.fromEntries(fields.map((key) => [key, mapped.get(value[key].toLowerCase())])) };
      }
    }
    let saved;
    switch (command.operation) {
      case 'create_state': saved = await saveWorkflowState(client, identity, versionId, expected, value); break;
      case 'patch_state': saved = await patchWorkflowState(client, identity, versionId, expected, elementId, value); break;
      case 'delete_state': saved = await deleteWorkflowElement(client, identity, versionId, expected, { type: 'state', id: elementId }); break;
      case 'create_transition': saved = await saveWorkflowTransition(client, identity, versionId, expected, value); break;
      case 'patch_transition': saved = await patchWorkflowTransition(client, identity, versionId, expected, elementId, value); break;
      case 'delete_transition': saved = await deleteWorkflowElement(client, identity, versionId, expected, { type: 'transition', id: elementId }); break;
      case 'publish':
        fieldsOnly(value, ['changeSummary']);
        saved = await publishWorkflow(client, identity, versionId, expected, text(value.changeSummary, 'Change summary', 2000)); break;
      case 'save_flow':
        fieldsOnly(value, ['changeSummary']);
        saved = await saveWorkflowFlow(client, identity, versionId, expected, text(value.changeSummary, 'Change summary', 2000)); break;
    }
    // The fingerprint retains the requested command. The typed receipt records
    // its actual publication or inactive-draft outcome for exact later retries.
    const operation = command.operation === 'save_flow' ? saved.status === 'published' ? 'publish' : 'save_draft' : command.operation;
    const resultElementId = saved.id ?? elementId ?? null;
    const result = (await client.query(`INSERT INTO workflow_editor_commands(organization_id,request_id,workflow_id,source_version_id,source_revision,
      workflow_version_id,revision,operation,source_element_id,element_id,fingerprint,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING workflow_id,workflow_version_id,revision,operation,element_id`,
    [org, command.requestId, command.workflowId, command.versionId, command.revision, versionId, saved.revision, operation,
      command.elementId ?? null, resultElementId, command.fingerprint, identity.user_id])).rows[0];
    return commandResult(result);
  } catch (error) {
    if (error.constraint === 'workflow_editor_command_pk') throw reused();
    if (error.constraint === 'workflow_editor_command_revision_key') throw stale();
    if (error.constraint === 'workflow_metadata_session_required') throw new HttpError(403, 'forbidden', 'Your workflow management access changed. Sign in again before saving.');
    throw error;
  }
}
