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
import { serviceAgreementDateDisplay } from '../../masters/service-agreement-fields.js';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';
const choiceLoader = kind => async (search, { signal }) => {
  const result = await apiRequest('/api/masters/service-agreements/options', { method: 'POST', body: { kind, search }, signal });
  return { options: result.rows.map(row => ({ value: row.id, label: row.name })), hasMore: result.hasMore };
};
const vendorChoices = choiceLoader('vendors'); const instrumentChoices = choiceLoader('instruments');

export default function ServiceAgreementList({ canManage, canRead }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const returnPath = `/service_agreements${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'vendor_id', header: 'Vendor', searchable: true, filterType: 'relation', loadFilterOptions: vendorChoices },
    { key: 'equipment_ids', header: 'Equipments', searchable: true, filterType: 'relation', loadFilterOptions: instrumentChoices, format: value => value.join(', ') },
    { key: 'start_date', header: 'Start Date', searchable: true, type: 'date', format: serviceAgreementDateDisplay },
    { key: 'end_date', header: 'End Date', searchable: true, type: 'date', format: serviceAgreementDateDisplay },
    { key: 'cost', header: 'Cost', searchable: true },
    { key: 'actions', header: 'Actions', minWidth: 160, render: row => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/service_agreements/${row._id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <><Link className={actionClass} href={`/service_agreements/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link>
        <button type="button" className="btn btn-sm btn-danger d-flex align-items-center gap-1 flex-shrink-0 text-nowrap" onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}><AppIcon name="trash" size="0.85em" />Delete</button></> : null}
    </div> },
  ], [canManage, returnPath]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload;
    return apiRequest(`/api/masters/service-agreements?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload(value => value + 1); };
    const interval = window.setInterval(refresh, 10_000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  async function remove() {
    if (deleting) return; setDeleting(true); setError('');
    try {
      await apiRequest(`/api/masters/service-agreements/${deletion._id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } });
      setDeletion(null); setReload(value => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  if (!canRead) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">Service Agreement module access is required.</div></div>;
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Service Agreements</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/service_agreements/new?from=${encodeURIComponent(returnPath)}`)}>New Service Agreement</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />
    <Modal open={Boolean(deletion)} title="Delete Service Agreement" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</PrimaryButton>
    </>}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <p>Delete the Service Agreement with <strong>{deletion?.vendor_id}</strong>?</p><p className="mb-0 text-muted">This Service Agreement will be removed from the list.</p>
    </Modal>
  </>;
}
