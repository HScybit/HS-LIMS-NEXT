'use client';

import { useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';

const formId = 'workflow-details-form';

export default function WorkflowDetails({ workflow, onClose, onSaved }) {
  const [name, setName] = useState(workflow.name); const [description, setDescription] = useState(workflow.description ?? '');
  const [appliesTo, setAppliesTo] = useState(workflow.appliesTo ?? 'sample');
  const [revision, setRevision] = useState(workflow.metadataRevision); const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const command = useRef(null); const pending = useRef(false);
  async function save(event) {
    event.preventDefault();
    if (pending.current) return;
    if (!name.trim()) { setError({ message: 'Workflow name is required.' }); return; }
    command.current ??= { requestId: crypto.randomUUID(), metadataRevision: revision, name: name.trim(), description, appliesTo };
    pending.current = true; setBusy(true); setError(null);
    try {
      const saved = await apiRequest(workflow.isNew ? '/api/workflows' : `/api/workflows/${workflow.id}`, {
        method: workflow.isNew ? 'POST' : 'PATCH', body: { ...command.current, ...(workflow.isNew ? { id: workflow.id } : {}) },
      });
      onSaved(saved, workflow.isNew);
    } catch (failure) {
      const unknown = !failure.status || failure.status >= 500;
      if (!unknown) command.current = null;
      setUncertain(unknown); setError(failure);
    } finally { pending.current = false; setBusy(false); }
  }
  async function reload() {
    if (pending.current) return; pending.current = true; setBusy(true);
    try {
      const current = await apiRequest(`/api/workflows/${workflow.id}`);
      setName(current.name); setDescription(current.description ?? ''); setAppliesTo(current.appliesTo); setRevision(current.metadataRevision); setError(null);
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal open title={workflow.isNew ? 'Add Workflow' : 'Edit Workflow'} titleIcon={workflow.isNew ? 'plus' : 'edit'}
    size="lg" cardClassName="workflow-modal workflow-modal--details" onClose={() => { if (!pending.current) onClose(); }} actions={<>
      <SecondaryButton size="medium" disabled={busy} onClick={onClose}>Cancel</SecondaryButton>
      <PrimaryButton type="submit" form={formId} leftIcon="save" disabled={busy}>{busy ? 'Saving...' : uncertain ? 'Retry Save' : 'Save'}</PrimaryButton>
    </>}>
    <form id={formId} className="workflow-form" onSubmit={save}>
      {error ? <div className="alert alert-danger py-2" role="alert">{error.message}
        {error.code === 'stale_workflow_metadata' ? <button type="button" className="btn btn-link" disabled={busy} onClick={reload}>Reload details</button> : null}
      </div> : null}
      <label className="workflow-field"><span>Name<b>*</b></span><input className="form-control" required maxLength={200} value={name} readOnly={busy || uncertain} onChange={(event) => setName(event.target.value)} /></label>
      <label className="workflow-field"><span>Description</span><input className="form-control" maxLength={10000} value={description} readOnly={busy || uncertain} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="workflow-field"><span>Applies To<b>*</b></span><select className="form-select" required value={appliesTo} disabled={busy || uncertain} onChange={event => setAppliesTo(event.target.value)}>
        <option value="sample">Sample</option><option value="test_request">Test Request</option><option value="instrument_service">Instrument Service</option>
      </select></label>
    </form>
  </Modal>;
}
