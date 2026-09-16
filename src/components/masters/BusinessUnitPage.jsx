'use client';

import { useEffect, useState } from 'react';
import BusinessUnitForm from './BusinessUnitForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function BusinessUnitView({ unit }) {
  const rows = [['Name', unit.name], ['Description', unit.description], ['Code', unit.code], ['Active', unit.active ? 'Yes' : 'No'],
    ['Created At', new Date(unit.createdAt).toLocaleDateString('en-GB')]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}
export default function BusinessUnitPage({ unitId, mode, canManage }) {
  const [unit, setUnit] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!unitId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/administration/business-units/${unitId}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setUnit(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [unitId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage units.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!unitId) return <BusinessUnitForm />;
  if (!unit || unit.id !== unitId.toLowerCase()) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Unit...</div></div>;
  return mode === 'view' ? <BusinessUnitView unit={unit} /> : <BusinessUnitForm key={unit.id} unit={unit} />;
}
