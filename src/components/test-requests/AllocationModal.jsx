'use client';

import { useEffect, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormElement from '../ui/FormElement.jsx';
import DataTable from '../ui/DataTable.jsx';
import { apiRequest } from '../../lib/api-client.js';
import '../../styles/test-request-allocation-modals.scss';

export default function AllocationModal({ request, onClose, onAllocated }) {
  const [options, setOptions] = useState(null); const [assignee, setAssignee] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try { const result = await apiRequest(`/api/test-requests/${request.id}/allocation-options`, { signal: controller.signal }); if (!controller.signal.aborted) { setOptions(result); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [request.id, reload]);
  const close = () => { if (!busy) onClose(); };
  async function submit(event) {
    event.preventDefault(); if (!assignee || busy) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/api/test-requests/${request.id}/assignments`, { method: 'POST', body: { revision: request.revision, assignmentType: 'analyst', assignedUserId: assignee } });
      onAllocated();
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <Modal open title="Allocate Test Request" titleIcon="user-plus" size="xl" onClose={close} cardClassName="smplfy-tr-allocation-modal-dialog" bodyClassName="p-0 overflow-hidden">
    <div className="h-100 d-flex overflow-hidden"><section className="d-flex flex-column flex-grow-1 overflow-hidden border-end">
      <div><dl className="mb-0 d-grid">{[['Product', request.productName], ['Parameter', request.parameterName], ['Test Method', request.methodName]].map(([label, value]) => <div className="row g-0 align-items-start" key={label}><dt className="col-auto mb-0">{label}</dt><dd className="col mb-0">{value}</dd></div>)}</dl></div>
      <div className="d-flex flex-column flex-grow-1 overflow-hidden border-top"><div className="nav nav-tabs border-0 flex-shrink-0" role="tablist" aria-label="Allocation resources"><button type="button" className="smplfy-nav-link nav-link active" role="tab" aria-selected="true">Analysts</button></div>
        <div className="flex-grow-1 overflow-auto"><DataTable><thead><tr>{['Sr.', 'User Name', '# of TR for Parameter', 'Last Tested On', 'Workload (# TRs)', 'Has Valid Certification?', 'On leave?', 'Workload Sheet'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{options ? options.users.map((user, index) => <tr key={user.id}><td>{index + 1}</td><td>{user.name}</td><td>{user.parameterWorkload}</td><td>—</td><td>{user.workload}</td><td>—</td><td>—</td><td>—</td></tr>) : <tr><td colSpan={8}>{error ? 'Unable to load allocation data.' : 'Loading allocation data...'}</td></tr>}</tbody>
        </DataTable></div>
      </div>
    </section><aside className="d-flex flex-column justify-content-between flex-shrink-0 overflow-hidden">
      <form id="allocate-test-request-form" onSubmit={submit} className="d-flex flex-column gap-4 overflow-hidden">
        {error ? <div className="alert alert-danger" role="alert">{error}{!options ? <button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button> : null}</div> : null}
        <FormElement label="Allocate to" mandatory type="searchable-select" inputProps={{ value: assignee, onChange: setAssignee, options: (options?.users ?? []).map((user) => ({ value: user.id, label: user.name })), placeholder: 'Select person', disabled: busy || !options }} />
      </form>
      <div className="modal-footer border-top d-flex align-items-center justify-content-between"><SecondaryButton leftIcon="close" size="large" onClick={close} disabled={busy}>Cancel</SecondaryButton><PrimaryButton type="submit" form="allocate-test-request-form" leftIcon="user-plus" disabled={busy || !assignee}>{busy ? 'Allocating...' : 'Allocate'}</PrimaryButton></div>
    </aside></div>
  </Modal>;
}
