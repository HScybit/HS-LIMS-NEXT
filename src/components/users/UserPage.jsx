'use client';

import { useEffect, useState } from 'react';
import UserForm from './UserForm.jsx';
import { UserSignaturePreview } from './UserSignatureField.jsx';
import { apiRequest } from '../../lib/api-client.js';
import '../../styles/users.scss';

function UserView({ data }) {
  const profile = data.profile; const rows = [
    ['Name', data.account.displayName], ['Email', data.account.email], ['Contact Number', profile.phone], ['Username/Employee ID', data.account.username],
    ['Can be Manager?', typeof profile.canManagePeople === 'boolean' ? profile.canManagePeople ? 'Yes' : 'No' : null], ['Designation', profile.designation],
    ['Unit', profile.businessUnitName], ['Default Role', data.user.defaultRoleName], ['Lab', profile.laboratoryName], ['Reporting Manager', profile.reportingManagerName],
  ];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4"><div className="table-responsive">
    <table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.map(([label, value]) => <tr key={label}><td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td>
        <td className="py-2 px-3"><div className="d-flex align-items-center justify-content-between gap-2"><span className="text-break">{value || '-'}</span></div></td></tr>)}
      <tr><td className="text-muted fw-semibold py-2 px-3 w-25">User Signature</td><td className="py-2 px-3"><UserSignaturePreview file={data.signature.file} detail /></td></tr>
    </tbody></table>
  </div></div></div></div>;
}

export default function UserPage({ userId, mode, canRead, canManage, currentUserId }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const [loadedRevision, setLoadedRevision] = useState(0);
  useEffect(() => {
    if (!userId || !canRead) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/users/${userId}/form`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setData(result); setLoadedRevision(reload); setError(''); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [userId, canRead, reload]);
  if (mode === 'new') return <UserForm canManage={canManage} currentUserId={currentUserId} />;
  if (mode === 'view' && !canRead || !data && !canRead) return <div className="alert alert-warning m-4" role="alert">You do not have permission to view users.</div>;
  return <>
    {error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry loading user</button></div> : null}
    {data ? mode === 'view' ? <UserView data={data} /> : <UserForm key={`${userId}:${loadedRevision}`} data={data} canManage={canManage} currentUserId={currentUserId} onReload={() => setReload(value => value + 1)} />
      : !error ? <p className="text-muted m-4" role="status">Loading User…</p> : null}
  </>;
}
