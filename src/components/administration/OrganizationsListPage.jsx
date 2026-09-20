'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import DataTable from '../ui/DataTable.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest } from '../../lib/api-client.js';

const statusTone = { active: 'bg-success', suspended: 'bg-warning text-dark', archived: 'bg-secondary' };
const statusLabel = { active: 'Active', suspended: 'Suspended', archived: 'Archived' };
const accountLabel = { saas: 'SaaS', enterprise: 'Enterprise' };
const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';

export default function OrganizationsListPage() {
  const columns = useMemo(() => [
    { key: 'name', header: 'Organization', searchable: true, render: (row) => <>
      <strong>{row.name}</strong>
      <small className="dt-cell-subtitle">{row.code}{row.domain ? ` · ${row.domain}` : ''}</small>
    </> },
    { key: 'accountType', header: 'Account', render: (row) => <>
      {accountLabel[row.accountType] ?? row.accountType}
      <small className="dt-cell-subtitle">{row.pricingPlan || 'No pricing plan'}</small>
    </> },
    { key: 'contactPerson', header: 'Contact', searchable: true, render: (row) => <>
      {row.contactPerson || '—'}
      <small className="dt-cell-subtitle">{row.contactPhone || ''}</small>
    </> },
    { key: 'status', header: 'Status', filterOptions: [
      { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'archived', label: 'Archived' },
    ], render: (row) => <span className={`badge ${statusTone[row.status] ?? 'bg-secondary'}`}>{statusLabel[row.status] ?? row.status}</span> },
    { key: 'actions', header: 'Actions', minWidth: 190, render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/administration/organizations/${row.id}/edit`}><AppIcon name="edit" /><span>Edit</span></Link>
      <Link className={actionClass} href={`/administration/organizations/${row.id}/seed`}><AppIcon name="fa-database" /><span>Seed data</span></Link>
    </div> },
  ], []);

  const loadRows = useCallback(async ({ page, pageSize, search, filters }) => {
    const params = new URLSearchParams({ search: search ?? '', status: filters?.status?.value || 'all',
      page: String(page), pageSize: String(pageSize) });
    const result = await apiRequest(`/api/administration/organizations?${params}`);
    return { rows: result.items, totalCount: result.total };
  }, []);

  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Organizations</h1></div>
      <div className="col-auto page-header__actions"><PrimaryButton leftIcon="plus" href="/administration/organizations/new">New Organization</PrimaryButton></div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />
  </>;
}
