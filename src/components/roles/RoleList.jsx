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
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import RoleBadges from './RoleBadges.jsx';
import { useRoleSettings } from './useRoleSettings.js';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';

function RoleView({ id, settings, onClose }) {
  const [role, setRole] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest(`/api/roles/${id}`, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setRole(value); setError(''); }
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [id, reload]);
  return <Modal open title="View Role" size="large" onClose={onClose}>
    {error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
    {role ? <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle table-bordered mb-0"><tbody>
      {[['Name', role.name], ['Description', role.description], ['Default Url', role.defaultPath]].map(([label, value]) => <tr key={label}>
        <th className="text-muted fw-semibold py-2 px-3 w-25">{label}</th><td className="py-2 px-3"><div className="text-break">{value || '-'}</div></td>
      </tr>)}<tr><th className="text-muted fw-semibold py-2 px-3">Permissions</th><td className="py-2 px-3"><RoleBadges role={role} settings={settings} /></td></tr>
    </tbody></table></div> : !error ? <p className="text-muted" role="status">Loading Role...</p> : null}
  </Modal>;
}

export default function RoleList({ canManage }) {
  const router = useRouter(); const search = useSearchParams(); const [reload, setReload] = useState(0);
  const [view, setView] = useState(null); const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  const { settings, error: settingsError, retry } = useRoleSettings();
  const returnPath = `/role_management${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'name', header: 'Role name', searchable: true },
    { key: 'permissions', header: 'Permissions', sortable: false, render: (row) => <RoleBadges role={row} settings={settings} /> },
    { key: 'actions', header: 'Actions', minWidth: 160, render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2">
      <button type="button" className={actionClass} onClick={() => setView(row._id)}><AppIcon name="eye" /><span>View</span></button>
      {canManage ? <><Link className={actionClass} href={`/role_management/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}><AppIcon name="edit" /><span>Edit</span></Link>
        <button type="button" className="btn btn-sm btn-danger d-flex align-items-center gap-1 flex-shrink-0 text-nowrap" disabled={row.protected}
          onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setError(''); }}><AppIcon name="trash" size="0.85em" />Delete</button></> : null}
    </div> },
  ], [canManage, returnPath, settings]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => {
    void reload; return apiRequest(`/api/roles?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload((value) => value + 1); };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  async function remove() {
    if (deleting) return; setDeleting(true); setError('');
    try {
      await apiRequest(`/api/roles/${deletion._id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } });
      setDeletion(null); setReload((value) => value + 1); notifySessionChange();
    } catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Role Master</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push(`/role_management/new?from=${encodeURIComponent(returnPath)}`)}>New Role</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    {settingsError ? <div className="alert alert-danger m-4" role="alert">{settingsError}<button type="button" className="btn btn-link" onClick={retry}>Retry loading settings</button></div> : null}
    {settings ? <DataTable columns={columns} loadRows={loadRows} /> : !settingsError ? <p className="text-muted m-4" role="status">Loading role settings...</p> : null}
    {view ? <RoleView key={view} id={view} settings={settings} onClose={() => setView(null)} /> : null}
    <Modal open={Boolean(deletion)} title="Delete Role" onClose={() => { if (!deleting) setDeletion(null); }} actions={<>
      <SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</PrimaryButton>
    </>}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <p>Delete <strong>{deletion?.name}</strong>?</p><p className="mb-0 text-muted">This role will be removed from the list. Existing references and saved history will be retained.</p>
    </Modal>
  </>;
}
