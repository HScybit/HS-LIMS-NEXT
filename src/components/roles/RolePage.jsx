'use client';

import { useEffect, useState } from 'react';
import RoleForm from './RoleForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function RolePage({ roleId, canManage }) {
  const [role, setRole] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!roleId || !canManage) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/roles/${roleId}`, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setRole(value); setError(''); }
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [roleId, canManage, reload]);
  if (!canManage) return <div className="alert alert-warning m-4" role="alert">You do not have permission to manage roles.</div>;
  if (error) return <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div>;
  if (!roleId) return <RoleForm />;
  if (!role) return <p className="text-muted m-4" role="status">Loading Role...</p>;
  return <RoleForm key={role.id} role={role} />;
}
