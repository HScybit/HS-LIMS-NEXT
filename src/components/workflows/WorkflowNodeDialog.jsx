'use client';

import { useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import { workflowBadgeColors, workflowNodeFlags, workflowNodeRoles, workflowNodeForm, workflowNodeSaveInput } from '../../workflows/node-form.js';
import { useWorkflowNodeReferences, WorkflowReferenceField } from './WorkflowReferences.jsx';

const formId = 'workflow-node-form';
const actionFields = [...workflowNodeFlags.slice(0, -1), ['stateType', 'Final State'], workflowNodeFlags.at(-1)];

export default function WorkflowNodeDialog({ node, states, action, onSave, onClose, onReload, onDirtyChange }) {
  const [value, setValue] = useState(() => workflowNodeForm(node, states));
  const [error, setError] = useState(null); const changed = useRef(new Set());
  const references = useWorkflowNodeReferences((node?.capabilityRoles ?? []).map((role) => role.roleId), node?.templateId);
  const locked = action.busy || action.uncertain || action.stale;
  function update(field, next) {
    changed.current.add(field); setValue((current) => ({ ...current, [field]: next })); onDirtyChange(true);
  }
  async function submit(event) {
    event.preventDefault(); if (action.busy || action.stale) return;
    try {
      const input = workflowNodeSaveInput(node, value, changed.current, states); setError(null);
      if (node && !Object.keys(input).length) { onClose(true); return; }
      await onSave(input);
    } catch (failure) { setError(failure.message); }
  }
  return <Modal open title="Node Details" titleIcon="settings" size="xl" cardClassName="workflow-modal workflow-modal--node"
    onClose={() => { if (!action.busy && !action.uncertain) onClose(); }} actions={<>
      <SecondaryButton size="medium" disabled={action.busy || action.uncertain} onClick={() => onClose()}>Cancel</SecondaryButton>
      <PrimaryButton type="submit" form={formId} leftIcon="save" disabled={action.busy || action.stale}>
        {action.busy ? 'Saving...' : action.uncertain ? action.saved ? 'Retry Reload' : 'Retry Save' : 'Save Node'}
      </PrimaryButton>
    </>}>
    <form id={formId} className="workflow-form" onSubmit={submit}>
      {error || action.error ? <div className="alert alert-danger py-2" role="alert">{error || action.error.message}
        {action.stale ? <button type="button" className="btn btn-link" disabled={action.busy} onClick={onReload}>Reload workflow</button> : null}
      </div> : null}
      {references.error ? <div className="alert alert-warning py-2" role="alert">Selections could not be loaded: {references.error.message}
        <button type="button" className="btn btn-link" onClick={references.retry}>Retry selections</button>
      </div> : null}
      <div className="workflow-node-modal-layout">
        <div className="workflow-node-modal-column">
          <section className="workflow-modal-section workflow-modal-section--basic"><div className="workflow-modal-section__title">Basic</div>
            <div className="workflow-form-grid workflow-form-grid--basic">
              <label className="workflow-field"><span>Name<b>*</b></span><input className="form-control" required maxLength={150} value={value.name} readOnly={locked} onChange={(event) => update('name', event.target.value)} /></label>
              <div className="workflow-form-grid workflow-form-grid--ports">{[['inputCount', 'Inputs'], ['outputCount', 'Outputs']].map(([field, label]) => <label className="workflow-field" key={field}>
                <span>{label}<b>*</b></span><input className="form-control" type="number" min="0" max="8" step="1" required value={value[field]} readOnly={locked} onChange={(event) => update(field, event.target.value)} />
              </label>)}</div>
              <WorkflowReferenceField label="Template" kind="templates" value={value.templateId} onChange={(id) => update('templateId', id || null)}
                catalog={references.templates} disabled={locked || references.loading || Boolean(references.error)} />
            </div>
          </section>
          <section className="workflow-modal-section workflow-modal-section--badge"><div className="workflow-modal-section__title">Badge Style</div>
            <div className="workflow-badge-style"><div className="workflow-badge-style__field"><div className="workflow-badge-style__label">Color</div>
              <div className="workflow-badge-color-list" role="group" aria-label="Badge color">{workflowBadgeColors.map((color) => <button key={color} type="button" disabled={locked}
                className={`workflow-badge-color-option workflow-badge-color-option--${color}${value.color === color ? ' is-selected' : ''}`} aria-label={`${color} badge color`}
                aria-pressed={value.color === color} onClick={() => update('color', color)}>{value.color === color ? <span className="workflow-badge-style__check"><AppIcon name="check" /></span> : null}</button>)}</div>
            </div><div className="workflow-badge-style__footer"><div className="workflow-badge-style__field"><div className="workflow-badge-style__label">Style</div>
              <div className="workflow-badge-style-toggle" role="group" aria-label="Badge style">{['light', 'dark'].map((style) => <button type="button" key={style} disabled={locked}
                className={`workflow-badge-style-toggle__option${value.badgeStyle === style ? ' is-selected' : ''}`} aria-pressed={value.badgeStyle === style} onClick={() => update('badgeStyle', style)}>
                {style === 'light' ? 'Light' : 'Dark'}{value.badgeStyle === style ? <span className="workflow-badge-style__check"><AppIcon name="check" /></span> : null}</button>)}</div>
            </div><div className="workflow-badge-style__field workflow-badge-style__field--preview"><div className="workflow-badge-style__label">Preview</div>
              <StatusPill color={value.color} styleType={value.badgeStyle === 'dark' ? 'strong' : 'neutral'}>Pending</StatusPill>
            </div></div></div>
          </section>
        </div>
        <section className="workflow-modal-section workflow-modal-section--actions"><div className="workflow-modal-section__title">Node Actions</div>
          <div className="workflow-check-grid">{actionFields.map(([field, label]) => <label className="workflow-check" key={field}><input type="checkbox" disabled={locked}
            checked={field === 'stateType' ? value.stateType === 'final' : value[field]}
            onChange={(event) => update(field, field === 'stateType' ? event.target.checked ? 'final' : 'normal' : event.target.checked)} /><span>{label}</span></label>)}
          </div>
        </section>
        <section className="workflow-modal-section workflow-modal-section--permissions"><div className="workflow-modal-section__title">Permissions</div>
          <div className="workflow-form-grid workflow-form-grid--dropdown-rows">{workflowNodeRoles.map(([field, label]) => <WorkflowReferenceField key={field} label={label} kind="roles" multiple
            value={value[field]} onChange={(ids) => update(field, ids)} catalog={references.roles} disabled={locked || references.loading || Boolean(references.error)} />)}</div>
        </section>
      </div>
    </form>
  </Modal>;
}
