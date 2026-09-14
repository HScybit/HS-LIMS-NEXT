'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import DataTable from '../ui/DataTable.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import ToastNotification from '../ui/ToastNotification.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import WorkflowDetails from './WorkflowDetails.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function WorkflowList({ canManage }) {
  const router = useRouter(); const search = useSearchParams(); const legacyId = search.get('workflowId');
  const [reload, setReload] = useState(0); const [details, setDetails] = useState(null); const [toast, setToast] = useState('');
  const [operation, setOperation] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (legacyId) router.replace(`/workflow_management/${encodeURIComponent(legacyId)}`);
  }, [legacyId, router]);
  const run = useCallback(async (next) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(''); setOperation(next);
    try {
      const saved = await apiRequest(`/api/workflows/${next.workflowId}${next.kind === 'clone' ? '/clone' : ''}`, {
        method: next.kind === 'clone' ? 'POST' : 'DELETE', body: next.command,
      });
      setOperation(null); setReload((value) => value + 1);
      if (next.kind === 'clone') router.push(`/workflow_management/${saved.workflowId}`);
      else setToast('Workflow deleted.');
    } catch (failure) {
      setError(failure.message);
      if (failure.status && failure.status < 500) setOperation(null);
    } finally { pending.current = false; setBusy(false); }
  }, [router]);
  const columns = useMemo(() => [
    { key: 'name', header: 'Name', searchable: true },
    { key: 'description', header: 'Description', searchable: true },
    { key: 'created_at', header: 'Created At', type: 'date' },
    { key: 'actions', header: 'Actions', filterable: false, sortable: false, render: (workflow) => <div className="workflow-row-actions">
      {canManage ? <SecondaryButton size="medium" leftIcon="edit" onClick={() => setDetails(workflow)}>Details</SecondaryButton> : null}
      <PrimaryButton size="medium" leftIcon="settings" to={`/workflow_management/${workflow.id}`}>Flow</PrimaryButton>
      {canManage ? <>
        <SecondaryButton size="medium" leftIcon="clipboard-text" disabled={Boolean(operation)} onClick={() => run({ kind: 'clone', workflowId: workflow.id,
          command: { id: crypto.randomUUID(), requestId: crypto.randomUUID() } })}>Clone</SecondaryButton>
        <SecondaryButton size="medium" tone="danger" leftIcon="trash" disabled={Boolean(operation)} onClick={() => {
          if (window.confirm('Delete this workflow? This cannot be undone.')) run({ kind: 'delete', workflowId: workflow.id,
            command: { requestId: crypto.randomUUID(), metadataRevision: workflow.metadataRevision } });
        }}>Delete</SecondaryButton>
      </> : null}
    </div> },
  ], [canManage, operation, run]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload; return apiRequest(`/api/workflows?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload((value) => value + 1); };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row page-header__row h-100 align-items-center justify-content-between gx-0">
      <div className="col page-header__start"><h1 className="page-title mb-0">Workflow Master</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => setDetails({ id: crypto.randomUUID(), name: '', description: '', metadataRevision: 0, isNew: true })}>Add Workflow</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    {error ? <div className="alert alert-danger m-4" role="alert">{error}
      {operation ? <button type="button" className="btn btn-link" disabled={busy} onClick={() => run(operation)}>Retry {operation.kind === 'clone' ? 'clone' : 'delete'}</button> : null}
      {!busy ? <button type="button" className="btn btn-link" onClick={() => { setError(''); setOperation(null); setReload((value) => value + 1); }}>Dismiss</button> : null}
    </div> : null}
    <DataTable columns={columns} loadRows={loadRows} />
    {details ? <WorkflowDetails key={details.id} workflow={details} onClose={() => { setDetails(null); setReload((value) => value + 1); }}
      onSaved={(saved, isNew) => { setDetails(null); setReload((value) => value + 1); setToast('Workflow saved.'); if (isNew) router.push(`/workflow_management/${saved.workflowId}`); }} /> : null}
    {toast ? <div className="position-fixed bottom-0 start-0 p-3" style={{ zIndex: 1080 }}><ToastNotification message={toast} onClose={() => setToast('')} /></div> : null}
  </>;
}
