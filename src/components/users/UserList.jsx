'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { userReferences } from './UserReferenceField.jsx';
import { customFieldListDisplay, userCustomFieldColumnKey } from '../../custom-fields/listing-values.js';
import '../../styles/users.scss';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';
const dateTime = value => value ? new Date(value).toLocaleString() : '-';
function UserCard({ row, col }) {
  const name = row.displayName || row.username || 'Unknown';
  return <div className="user-directory-card"><div className="user-directory-avatar" aria-hidden="true">{name.split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase()}</div>
    <div><Link className="user-directory-name" href={`/user_management/${row.id}/${col.canManage ? 'edit' : 'view'}?from=${encodeURIComponent(col.returnPath)}`}>{name}</Link>
      <div className="user-directory-email">Email: {row.email || '-'}</div><div>Username: {row.username || '-'}</div><div>Organization: {row.organizationName || '-'}</div></div>
  </div>;
}
function UserStatus({ row, col }) {
  const { pending, saving, error } = col.commands[row.id] ?? {};
  const disabled = !col.canManage || row.id === col.currentUserId;
  return <div><button type="button" className={`user-status-toggle ${row.membershipActive ? 'is-active' : 'is-inactive'}`} disabled={disabled || saving || Boolean(pending)}
    title={row.id === col.currentUserId ? 'You cannot disable your own membership' : `Click to set ${row.membershipActive ? 'Inactive' : 'Active'}`}
    onClick={() => col.onSave(row, { requestId: crypto.randomUUID(), revision: row.statusRevision, membershipActive: !row.membershipActive })}>
    <span aria-hidden="true" />{saving ? '...' : row.membershipActive ? 'Active' : 'Inactive'}</button>
    {!row.identityActive ? <div className="small text-muted">Global account disabled</div> : null}
    {error ? <div className="small text-danger mt-1" role="alert">{error.message}
      <button type="button" className="btn btn-link btn-sm" disabled={disabled || saving} onClick={() => col.onSave(row, pending)}>Retry status change</button>
      {error.status && error.status < 500 ? <button type="button" className="btn btn-link btn-sm" disabled={saving} onClick={() => col.onReload(row.id)}>Reload status</button> : null}
    </div> : null}
  </div>;
}
async function roleFilterOptions(search, { signal }) {
  const result = await userReferences('roles', { search, pageSize: 100, includeInactive: true }, signal);
  return { options: result.rows.map(row => ({ value: row.id, label: row.description || row.name })), hasMore: result.hasMore };
}

export default function UserList({ canManage, currentUserId }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const [customFields, setCustomFields] = useState(null); const [customFieldError, setCustomFieldError] = useState('');
  // DataTable replaces its rows with skeletons during refresh; pending commands must outlive those cells.
  const [commands, setCommands] = useState({});
  const refresh = useCallback(() => setReload(value => value + 1), []);
  const reloadStatus = useCallback((id) => { setCommands(current => { const next = { ...current }; delete next[id]; return next; }); refresh(); }, [refresh]);
  const saveStatus = useCallback(async (row, pending) => {
    if (!canManage || row.id === currentUserId || commands[row.id]?.saving) return;
    setCommands(current => ({ ...current, [row.id]: { pending, saving: true, error: null } }));
    try { await apiRequest(`/api/users/${row.id}/status`, { method: 'PATCH', body: pending }); reloadStatus(row.id); notifySessionChange(); }
    catch (error) { setCommands(current => ({ ...current, [row.id]: { pending, saving: false, error } })); }
  }, [canManage, currentUserId, commands, reloadStatus]);
  const returnPath = `/user_management${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'displayName', header: 'User', searchable: true, component: UserCard, canManage, returnPath },
    { key: 'defaultRoleName', header: 'Role', searchable: true },
    { key: 'defaultRoleDescription', header: 'Role Description', filterType: 'relation', loadFilterOptions: roleFilterOptions },
    { key: 'businessUnitName', header: 'Unit', searchable: true },
    { key: 'identityCreatedAt', header: 'Created on', type: 'date' },
    { key: 'lastLoginAt', header: 'Last login', format: dateTime },
    { key: 'lastLogoutAt', header: 'Last logout', format: dateTime },
    { key: 'membershipActive', header: 'Status', type: 'boolean', component: UserStatus, canManage, currentUserId, commands, onSave: saveStatus, onReload: reloadStatus },
    ...(customFields ?? []).map(field => ({ key: userCustomFieldColumnKey(field), header: field.label, searchable: field.showInFilter,
      filterable: field.showInFilter, hidden: !field.showInList, minWidth: 150,
      format: (_value, row) => customFieldListDisplay(row.customFields?.[field.key], field) || '-',
      ...(field.fieldType === 'select' && field.options.length ? { filterOptions: field.options.map(option => ({ value: option.label, label: option.label })) } : {}),
    })),
    { key: 'actions', header: 'Actions', minWidth: 160, render: row => <div className="d-flex flex-nowrap align-items-center gap-2">
      <Link className={actionClass} href={`/user_management/${row.id}/view?from=${encodeURIComponent(returnPath)}`}><AppIcon name="eye" /><span>View</span></Link>
      {canManage ? <Link className={actionClass} href={`/user_management/${row.id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link> : null}
    </div> },
  ], [canManage, currentUserId, returnPath, commands, saveStatus, reloadStatus, customFields]);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('/api/users/custom-fields?view=list', { signal: controller.signal }).then(({ fields }) => {
      if (controller.signal.aborted) return;
      const sorted = [...fields].sort((left, right) => left.displayOrder - right.displayOrder || left.label.localeCompare(right.label));
      setCustomFields(current => current && JSON.stringify(current) === JSON.stringify(sorted) ? current : sorted); setCustomFieldError('');
    }).catch(failure => { if (!controller.signal.aborted) setCustomFieldError(failure.message); });
    return () => controller.abort();
  }, [reload]);
  const loadRows = useCallback(async ({ page, pageSize, search, filters, sort }) => {
    void reload;
    // DataTable labels belong to the visible filter chips; only IDs/values belong in the query.
    const values = Object.fromEntries(Object.entries(filters ?? {}).map(([key, filter]) => { const value = { ...filter }; delete value.labels; return [key, value]; }));
    const result = await apiRequest(`/api/users?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters: values, sort,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))}`);
    return { ...result, rows: result.rows.map(row => ({ ...row, _id: row.id })) };
  }, [reload]);
  useEffect(() => {
    const visibleRefresh = () => { if (document.visibilityState !== 'hidden') refresh(); };
    const timer = window.setInterval(visibleRefresh, 10_000); window.addEventListener('focus', visibleRefresh); document.addEventListener('visibilitychange', visibleRefresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [refresh]);
  return <><PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
    <div className="col page-header__start"><h1 className="page-title mb-0">User Management</h1></div><div className="col-auto page-header__actions">
      {canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/user_management/new?from=${encodeURIComponent(returnPath)}`)}>New User</PrimaryButton> : null}
    </div></div></div></div></PageHeader>
    {customFieldError ? <div className="alert alert-danger m-4" role="alert">{customFieldError}<button type="button" className="btn btn-link" onClick={refresh}>Retry loading fields</button></div> : null}
    {customFields ? <DataTable columns={columns} loadRows={loadRows} tableLayout="auto" /> : !customFieldError
      ? <div className="text-muted m-4" role="status">Loading user fields...</div> : null}</>;
}
