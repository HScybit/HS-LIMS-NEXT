'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import MaterialFormModal from './MaterialFormModal.jsx';
import MaterialTransactionModal from './MaterialTransactionModal.jsx';
import { apiRequest } from '../../lib/api-client.js';
import '../../styles/materials-page.scss';

export default function MaterialsList({ canManage }) {
  const [reload, setReload] = useState(0); const [editing, setEditing] = useState(null); const [transaction, setTransaction] = useState(null);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const columns = useMemo(() => [
    { key: 'name', header: 'Name', searchable: true, render: row => <Link href={`/materials/${row.id}`} className="smplfy-link link-primary p-0">{row.name}</Link> },
    { key: 'classification', header: 'Category', searchable: true }, { key: 'description', header: 'Description', searchable: true },
    { key: 'code', header: 'Key', searchable: true }, { key: 'created_at', header: 'Created', type: 'date' },
    { key: 'actions', header: 'Action', filterable: false, render: row => canManage ? <div className="d-flex align-items-center gap-2 flex-nowrap">
      <SecondaryButton size="medium" leftIcon="edit" onClick={() => setEditing(row)}>Edit</SecondaryButton>
      <SecondaryButton size="medium" leftIcon="trash" onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}>Delete</SecondaryButton>
      <PrimaryButton size="medium" leftIcon="plus" onClick={() => setTransaction(row)}>New Transaction</PrimaryButton>
    </div> : null },
  ], [canManage]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload; return apiRequest(`/api/materials?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload(value => value + 1); };
    const interval = window.setInterval(refresh, 10000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  async function remove() {
    if (deleting) return; setDeleting(true); setError('');
    try { await apiRequest(`/api/materials/${deletion.id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } }); setDeletion(null); setReload(value => value + 1); }
    catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  return <>
    <PageHeader><div className="page-header smplfy-materials-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Materials</h1></div><div className="col-auto page-header__actions">
        {canManage ? <PrimaryButton leftIcon="plus" onClick={() => setEditing({})}>New Material</PrimaryButton> : null}
      </div></div></div></div></PageHeader>
    <div className="smplfy-materials-page"><DataTable columns={columns} loadRows={loadRows} /></div>
    {editing ? <MaterialFormModal key={editing.id ?? 'new'} material={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setReload(value => value + 1); }} /> : null}
    {transaction ? <MaterialTransactionModal key={transaction.id} material={transaction} onClose={() => setTransaction(null)} onSaved={() => { setTransaction(null); setReload(value => value + 1); }} /> : null}
    <Modal open={Boolean(deletion)} title="Delete Material" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting...' : 'Delete'}</PrimaryButton>
    </>}>{error ? <div className="alert alert-danger" role="alert">{error}</div> : null}<p>Delete <strong>{deletion?.name}</strong>?</p><p className="mb-0 text-muted">The material will be removed from the list. Its saved history and transactions will be retained.</p></Modal>
  </>;
}
