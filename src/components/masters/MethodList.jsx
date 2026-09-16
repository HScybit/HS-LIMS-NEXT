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
import { customFieldColumnKey, customFieldListDisplay } from '../../custom-fields/listing-values.js';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';

export default function MethodList({ canManage }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const [customFields, setCustomFields] = useState(null); const [customFieldError, setCustomFieldError] = useState('');
  const returnPath = `/method_of_analysis${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'name', header: 'Name', searchable: true }, { key: 'description', header: 'Description', searchable: true },
    { key: 'uuid', header: 'UUID', searchable: true }, { key: 'decimal_places', header: 'Decimal Places', searchable: true },
    { key: 'parse_num', header: 'Convert Number', searchable: true, type: 'boolean', format: (value) => value ? 'Yes' : 'No' },
    { key: 'has_access', header: 'Allowed Access', searchable: true },
    ...(customFields ?? []).map((field) => ({ key: customFieldColumnKey(field), header: field.label, searchable: field.showInFilter,
      filterable: field.showInFilter, hidden: !field.showInList, minWidth: 150,
      format: (_value,row) => customFieldListDisplay(row.customFields?.[field.id],field) || '-',
      ...(field.fieldType === 'select' && field.options.length ? { filterOptions: field.options.map((option) => ({ value: option.label,label: option.label })) } : {}),
    })),
    { key: 'actions', header: 'Actions', minWidth: 160, render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/method_of_analysis/${row._id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <><Link className={actionClass} href={`/method_of_analysis/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link>
        <button type="button" className="btn btn-sm btn-danger d-flex align-items-center gap-1 flex-shrink-0 text-nowrap" onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}><AppIcon name="trash" size="0.85em" />Delete</button></> : null}
    </div> },
  ], [canManage, returnPath, customFields]);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('/api/masters/methods/custom-fields?view=list', { signal: controller.signal }).then(({ fields }) => {
      if (controller.signal.aborted) return;
      const sorted = [...fields].sort((left,right) => left.displayOrder-right.displayOrder || left.label.localeCompare(right.label));
      setCustomFields((current) => current && JSON.stringify(current) === JSON.stringify(sorted) ? current : sorted); setCustomFieldError('');
    }).catch((failure) => { if (!controller.signal.aborted) setCustomFieldError(failure.message); });
    return () => controller.abort();
  }, [reload]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload;
    return apiRequest(`/api/masters/methods?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
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
      await apiRequest(`/api/masters/methods/${deletion._id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } });
      setDeletion(null); setReload((value) => value + 1);
    } catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Method of Analysis</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/method_of_analysis/new?from=${encodeURIComponent(returnPath)}`)}>New Method of Analysis</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    {customFieldError ? <div className="alert alert-danger m-4" role="alert">{customFieldError}<button type="button" className="btn btn-link"
      onClick={() => setReload(value => value + 1)}>Retry loading fields</button></div> : null}
    {customFields ? <DataTable columns={columns} loadRows={loadRows} /> : !customFieldError
      ? <div className="text-muted m-4" role="status">Loading additional data fields...</div> : null}
    <Modal open={Boolean(deletion)} title="Delete Method of Analysis" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</PrimaryButton>
    </>}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <p>Delete <strong>{deletion?.name}</strong>?</p><p className="mb-0 text-muted">This method will be removed from the list. Existing sample references and saved history will be retained.</p>
    </Modal>
  </>;
}
