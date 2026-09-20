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

export default function DecisionRuleList({ canManage }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const returnPath = `/decision_rules${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'name', header: 'Name', searchable: true, format: (value, row) => value || (row.isTestGroupParent ? 'Test Group' : '—') },
    { key: 'productName', header: 'Product' }, { key: 'parameterName', header: 'Parameter' }, { key: 'methodName', header: 'MoA' },
    { key: 'isNabl', header: 'NABL', type: 'boolean', format: (value) => value ? 'Yes' : 'No' },
    { key: 'createdAt', header: 'Created At', type: 'date' },
    { key: 'actions', header: 'Actions', minWidth: 160, render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/decision_rules/${row._id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <><Link className={actionClass} href={`/decision_rules/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link>
        <button type="button" className="btn btn-sm btn-danger d-flex align-items-center gap-1 flex-shrink-0 text-nowrap" onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}><AppIcon name="trash" size="0.85em" />Delete</button></> : null}
    </div> },
  ], [canManage, returnPath]);
  const loadRows = useCallback(({ page, pageSize, search }) => {
    void reload;
    return apiRequest(`/api/masters/decision-rules?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload((value) => value + 1); };
    const interval = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  async function remove() {
    if (deleting) return; setDeleting(true); setError('');
    try {
      await apiRequest(`/api/masters/decision-rules/${deletion._id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } });
      setDeletion(null); setReload((value) => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Decision Rules</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/decision_rules/new?from=${encodeURIComponent(returnPath)}`)}>New Decision Rule</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />
    <Modal open={Boolean(deletion)} title="Delete Decision Rule" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</PrimaryButton>
    </>}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <p>Delete <strong>{deletion?.name || 'this Decision Rule'}</strong>?</p><p className="mb-0 text-muted">This rule will be removed from the list. Its saved history will be retained.</p>
    </Modal>
  </>;
}
