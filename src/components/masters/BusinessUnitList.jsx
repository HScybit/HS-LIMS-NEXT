'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest } from '../../lib/api-client.js';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';
export default function BusinessUnitList({ canManage }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const returnPath = `/unit_management${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'name', header: 'Unit Name', searchable: true }, { key: 'description', header: 'Description', searchable: true },
    { key: 'created_at', header: 'Created At', type: 'date' }, { key: 'code', header: 'Code', searchable: true },
    { key: 'active', header: 'Active', type: 'boolean', format: value => value ? 'Yes' : 'No' },
    { key: 'actions', header: 'Actions', minWidth: 160, render: row => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/unit_management/${row._id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <Link className={actionClass} href={`/unit_management/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link> : null}
    </div> },
  ], [canManage, returnPath]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload;
    return apiRequest(`/api/administration/business-units?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload(value => value + 1); };
    const interval = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Units</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/unit_management/new?from=${encodeURIComponent(returnPath)}`)}>New Unit</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />
  </>;
}
