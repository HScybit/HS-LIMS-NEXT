'use client';

import { useCallback, useMemo, useState } from 'react';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import Modal from '../ui/Modal.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import DataTable from '../ui/DataTable.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';

const actionClass = 'smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0 text-nowrap';
const formatWhen = (value) => (value ? new Date(value).toLocaleString() : 'Never');

// The directory groups people by organization, so scoping to one is how an
// administrator stops reading somebody else's staff list.
async function organizationChoices(search, { signal }) {
  const parameters = new URLSearchParams({ search: search ?? '', status: 'all', page: '1', pageSize: '100' });
  const result = await apiRequest(`/api/administration/organizations?${parameters}`, { signal });
  return { options: result.items.map((organization) => ({ value: organization.id, label: organization.name })),
    hasMore: result.total > result.items.length };
}

export default function PlatformUsersPage() {
  const [target, setTarget] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  const columns = useMemo(() => [
    { key: 'username', header: 'User', searchable: true, render: (row) => <>
      <strong>{row.displayName || row.username}</strong>
      <small className="dt-cell-subtitle">{row.username}{row.email ? ` · ${row.email}` : ''}</small>
    </> },
    { key: 'organizationName', header: 'Organization', searchable: true, render: (row) => <>
      {row.organizationName || '—'}
      <small className="dt-cell-subtitle">
        {row.organizationCode || 'No organization'}
        {row.organizationCount > 1 ? ` · ${row.organizationCount} organizations` : ''}
      </small>
    </> },
    { key: 'active', header: 'Status', render: (row) => <div className="d-flex flex-wrap gap-1">
      <span className={`badge ${row.active ? 'bg-success' : 'bg-secondary'}`}>{row.active ? 'Active' : 'Inactive'}</span>
      {row.isPlatformAdministrator ? <span className="badge bg-primary">Platform admin</span> : null}
      {row.mfaEnabled ? <span className="badge bg-info text-dark">MFA</span> : null}
      {row.mustChangePassword ? <span className="badge bg-warning text-dark">Must change</span> : null}
    </div> },
    { key: 'lastSignInAt', header: 'Last sign-in', render: (row) => <span className="text-nowrap">{formatWhen(row.lastSignInAt)}</span> },
    // DataTable treats any column with a `render` as an action column and keeps
    // it out of the filter panel, so the organization filter rides on a hidden
    // column of its own while the visible one keeps its two-line display.
    { key: 'organizationId', header: 'Organization', hidden: true, filterType: 'relation', loadFilterOptions: organizationChoices },
    { key: 'actions', header: 'Actions', minWidth: 170, render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2">
      <button type="button" className={actionClass} onClick={() => { setTarget(row); setError(''); }}>
        <AppIcon name="fa-key" /><span>Reset password</span>
      </button>
    </div> },
  ], []);

  const loadRows = useCallback(async ({ page, pageSize, search, filters }) => {
    void reload;
    const parameters = new URLSearchParams({ search: search ?? '', page: String(page), pageSize: String(pageSize) });
    for (const organizationId of filters?.organizationId?.value ?? []) parameters.append('organizationId', organizationId);
    const result = await apiRequest(`/api/administration/users?${parameters}`);
    return { rows: result.items, totalCount: result.total };
  }, [reload]);

  async function reset() {
    if (resetting) return;
    setResetting(true); setError('');
    try {
      const outcome = await apiRequest(`/api/administration/users/${target.id}/password`, { method: 'POST', body: {} });
      setIssued({ ...outcome, id: target.id });
      setTarget(null);
      setReload((value) => value + 1);
      showToast('Password reset.');
    } catch (failure) { setError(failure.message); }
    finally { setResetting(false); }
  }

  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Users</h1></div>
      <div className="col-auto page-header__actions"><SecondaryButton href="/administration/organizations">Organizations</SecondaryButton></div>
    </div></div></div></PageHeader>
    <DataTable columns={columns} loadRows={loadRows} />

    {target ? <Modal open title="Reset this password?" titleIcon="fa-exclamation-triangle" size="lg"
      onClose={resetting ? () => {} : () => setTarget(null)}
      actions={<div className="d-flex gap-2 justify-content-end">
        <SecondaryButton onClick={() => setTarget(null)} disabled={resetting}>Cancel</SecondaryButton>
        <PrimaryButton onClick={reset} disabled={resetting}>{resetting ? 'Resetting…' : 'Reset password'}</PrimaryButton>
      </div>}>
      <div className="seed-confirm">
        <div className="seed-confirm__warning">
          This replaces the password for <strong>{target.displayName || target.username}</strong>
          {target.organizationName ? <> in <strong>{target.organizationName}</strong></> : null}. Every session they
          are signed into ends immediately, and they must choose a new password the next time they sign in.
          {target.isPlatformAdministrator ? ' This account is a platform administrator.' : ''}
        </div>
        <p className="mb-0 text-secondary small">
          The new password is shown once, here, and cannot be retrieved afterwards. Your account is recorded against
          the reset.
        </p>
        {error ? <div className="alert alert-danger mb-0" role="alert">{error}</div> : null}
      </div>
    </Modal> : null}

    {issued ? <Modal open title="Password reset" titleIcon="check" size="lg"
      onClose={() => setIssued(null)}
      actions={<PrimaryButton onClick={() => setIssued(null)}>Done</PrimaryButton>}>
      <div className="seed-result">
        <p className="seed-result__lead">
          <strong>{issued.displayName || issued.username}</strong>
          {issued.organizationCode ? ` (${issued.organizationCode})` : ''} can sign in with the password below and
          will be asked to choose a new one. {issued.sessionsRevoked} session{issued.sessionsRevoked === 1 ? '' : 's'} ended.
        </p>
        <div>
          <div className="seed-result__block-title">One-time password</div>
          <p className="seed-result__hint">Share it now — it is not stored anywhere readable and cannot be shown again.</p>
          <table className="smplfy-table table table-hover align-middle mb-0">
            <thead><tr><th>Username</th><th>Temporary password</th></tr></thead>
            <tbody><tr><td><code>{issued.username}</code></td><td><code>{issued.temporaryPassword}</code></td></tr></tbody>
          </table>
        </div>
      </div>
    </Modal> : null}
  </>;
}
