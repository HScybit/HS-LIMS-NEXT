'use client';

import { useId, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import { workflowApprovalChoices, workflowAutoMoveChoices, workflowConnectionForm, workflowConnectionSaveInput } from '../../workflows/connection-form.js';
import { useWorkflowConnectionReferences, WorkflowReferenceField } from './WorkflowReferences.jsx';

const formId = 'workflow-connection-form';
function ChoiceField({ label, value, onChange, options, disabled }) {
  const id = useId();
  return <div className="workflow-field"><label htmlFor={id}>{label}<b>*</b></label>
    <SearchableSelect inputId={id} value={value} onChange={onChange} options={options} disabled={disabled} clearable={false} placeholder="Not recorded" />
  </div>;
}

export default function WorkflowConnectionDialog({ connection, ports, states, transitions, action, onSave, onDelete, onClose, onReload, onDirtyChange }) {
  const [value, setValue] = useState(() => workflowConnectionForm(connection)); const [error, setError] = useState(null); const changed = useRef(new Set());
  const roleIds = useMemo(() => [...connection?.creatorRoleIds ?? [], ...(connection?.approverStages ?? []).flatMap((stage) => stage.roleIds)], [connection]);
  const references = useWorkflowConnectionReferences(roleIds, connection?.checklistMasterId);
  const locked = action.busy || action.uncertain || action.stale; const referencesDisabled = locked || references.loading || Boolean(references.error);
  const checklist = [...references.checklists?.rows ?? [], ...references.checklists?.selected ?? []].find((row) => row.id === connection?.checklistMasterId);
  function update(field, next) {
    changed.current.add(field); setValue((current) => ({ ...current, [field]: next, ...(field === 'checklistMasterId' ? { refreshChecklist: false } : {}) })); onDirtyChange(true);
  }
  async function submit(event) {
    event.preventDefault(); if (action.busy || action.stale) return;
    try {
      if (action.uncertain) { await onSave(); return; }
      const input = workflowConnectionSaveInput(connection, value, changed.current, { states, transitions, ports }); setError(null);
      if (connection && !Object.keys(input).length) { onClose(true); return; }
      await onSave(input);
    } catch (failure) { setError(failure.message); }
  }
  return <Modal open title="Assign Approvers" titleIcon="user" size="xl" cardClassName="workflow-modal workflow-modal--connection" showCloseButton={false}
    onClose={() => { if (!action.busy && !action.uncertain) onClose(); }} actions={<>
      {onDelete ? <SecondaryButton size="medium" tone="danger" leftIcon="trash" disabled={locked} onClick={onDelete}>Delete Connection</SecondaryButton> : null}
      <div className="d-flex align-items-center justify-content-end flex-wrap gap-2 ms-auto">
        <SecondaryButton size="medium" disabled={action.busy || action.uncertain} onClick={() => onClose()}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" form={formId} leftIcon="save" disabled={action.busy || action.stale}>
          {action.busy ? action.operation === 'delete_transition' ? 'Deleting...' : 'Saving...' : action.uncertain ? action.saved ? 'Retry Reload' : action.operation === 'delete_transition' ? 'Retry Delete' : 'Retry Save' : 'Save Connection'}
        </PrimaryButton>
      </div>
    </>}>
    <form id={formId} className="workflow-form" onSubmit={submit}>
      {error || action.error ? <div className="alert alert-danger py-2" role="alert">{error || action.error.message}
        {action.stale ? <button type="button" className="btn btn-link" disabled={action.busy} onClick={onReload}>Reload workflow</button> : null}
      </div> : null}
      {references.error ? <div className="alert alert-warning py-2" role="alert">Selections could not be loaded: {references.error.message}
        <button type="button" className="btn btn-link" onClick={references.retry}>Retry selections</button>
      </div> : null}
      <div className="workflow-connection-modal-layout">
        <section className="workflow-modal-section"><div className="workflow-modal-section__title">Approval Rule</div>
          <div className="workflow-form-grid workflow-form-grid--dropdown-rows">
            <WorkflowReferenceField label="Approver Roles" kind="roles" multiple value={value.approverRoleIds} onChange={(ids) => update('approverRoleIds', ids)}
              catalog={references.roles} disabled={referencesDisabled || value.approvalMode === 'none'} />
            <WorkflowReferenceField label="Creator Roles" kind="roles" multiple value={value.creatorRoleIds} onChange={(ids) => update('creatorRoleIds', ids)}
              catalog={references.roles} disabled={referencesDisabled} />
            <ChoiceField label="Condition" value={value.approvalMode} onChange={(mode) => update('approvalMode', mode)} options={workflowApprovalChoices} disabled={locked} />
            <ChoiceField label="Auto Move" value={value.autoMoveMode} onChange={(mode) => update('autoMoveMode', mode)} options={workflowAutoMoveChoices} disabled={locked} />
          </div>
          {connection?.approvalMode === 'sequential' && connection.approverStages.length > 1 ? <p className="small text-muted mt-3 mb-0">Changing the approver roles replaces the current stages with a single stage.</p> : null}
        </section>
        <section className="workflow-modal-section"><div className="workflow-modal-section__title">Notifications</div>
          <div className="workflow-form-grid workflow-form-grid--single">
            <label className="workflow-field"><span>CC Emails</span><input className="form-control" value={value.ccEmailText} maxLength={32200} readOnly={locked}
              onChange={(event) => update('ccEmailText', event.target.value)} placeholder="email@example.com, team@example.com" /></label>
            <WorkflowReferenceField label="Node Checklist" kind="checklists" value={value.checklistMasterId} onChange={(id) => update('checklistMasterId', id || null)}
              catalog={references.checklists} disabled={referencesDisabled} />
            {connection?.checklistMasterId && connection.checklistMasterId === value.checklistMasterId ? <div>
              <SecondaryButton size="small" disabled={referencesDisabled || !checklist?.active} aria-pressed={value.refreshChecklist}
                onClick={() => update('refreshChecklist', !value.refreshChecklist)}>Refresh checklist</SecondaryButton>
              <p className="small text-muted mt-2 mb-0">{value.refreshChecklist ? 'The checklist will refresh when you save.' : 'The saved checklist stays unchanged until you select or refresh it.'}</p>
            </div> : null}
          </div>
        </section>
      </div>
    </form>
  </Modal>;
}
