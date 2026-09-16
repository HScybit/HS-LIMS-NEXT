'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
export default function NablList({ canManage, canRead }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0); const pending = useRef(false);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const returnPath = `/nabl_certificates${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: '_id', header: 'ID', searchable: true }, { key: 'validFrom', header: 'Valid From', type: 'date', format: value => value }, { key: 'validTo', header: 'Valid Till', type: 'date', format: value => value },
    { key: 'actions', header: 'Actions', minWidth: 160, render: row => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/nabl_certificates/${row._id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <><Link className={actionClass} href={`/nabl_certificates/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link>
        <button type="button" className="btn btn-sm btn-danger d-flex align-items-center gap-1 flex-shrink-0 text-nowrap" onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}><AppIcon name="trash" />Delete</button></> : null}
    </div> },
  ], [canManage, returnPath]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload; return apiRequest(`/api/operations/nabl-certifications?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    if (!canRead) return undefined;
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload(value => value + 1); };
    const interval = window.setInterval(refresh, 10_000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [canRead]);
  async function remove() {
    if (pending.current) return; pending.current = true; setDeleting(true); setError('');
    try {
      await apiRequest(`/api/operations/nabl-certifications/${deletion._id}`, { method: 'DELETE', body: { revision: deletion.revision, requestId: deletion.requestId } });
      setDeletion(null); setReload(value => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { pending.current = false; setDeleting(false); }
  }
  if (!canRead) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to view NABL certifications.</div></div>;
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">NABL Certification Management</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/nabl_certificates/new?from=${encodeURIComponent(returnPath)}`)}>New NABL Certification</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />
    <Modal open={Boolean(deletion)} title="Delete NABL Certification" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting...' : 'Delete'}</PrimaryButton>
    </>}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <p>Delete this NABL certification, valid from <strong>{deletion?.validFrom}</strong> to <strong>{deletion?.validTo}</strong>?</p>
      <p className="text-muted mb-0">It will be removed from the current listing. Saved revisions and original files will remain available in its history.</p>
    </Modal>
  </>;
}
