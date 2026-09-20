'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest } from '../../lib/api-client.js';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';

export default function ChecklistList({ canManage }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const returnPath = `/checklists${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'name', header: 'Name', searchable: true },
    { key: 'isActive', header: 'isActive', searchable: false, format: (_, row) => row.isActive ? 'Active' : 'Inactive' },
    { key: 'actions', header: 'Actions', minWidth: 160, render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/checklists/${row._id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <><Link className={actionClass} href={`/checklists/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link>
        <button type="button" className="btn btn-sm btn-danger d-flex align-items-center gap-1 flex-shrink-0 text-nowrap"
          onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}><AppIcon name="trash" size="0.85em" />Delete</button></> : null}
    </div> },
  ], [canManage, returnPath]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload; return apiRequest(`/api/checklists?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload((value) => value + 1); };
    const timer = window.setInterval(refresh, 10_000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  async function remove() {
    if (deleting) return; setDeleting(true); setError('');
    try {
      await apiRequest(`/api/checklists/${deletion._id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } });
      setDeletion(null); setReload((value) => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Checklists</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/checklists/new?from=${encodeURIComponent(returnPath)}`)}>New Checklist</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />
    <Modal open={Boolean(deletion)} title="Delete Checklist" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</PrimaryButton>
    </>}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <p className="mb-0">Delete <strong>{deletion?.name}</strong>?</p>
    </Modal>
  </>;
}
