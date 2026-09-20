'use client';

import { useEffect, useState } from 'react';
import LaboratoryForm from './LaboratoryForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function LaboratoryView({ laboratory }) {
  const rows = [['Name', laboratory.name], ['Abbreviation', laboratory.abbreviation], ['Head of Lab', laboratory.headUserName], ['Delegate Authority to', laboratory.delegateUserName],
    ['Min Temperature', laboratory.minimumTemperature], ['Max Temperature', laboratory.maximumTemperature], ['Min Humidity', laboratory.minimumHumidity], ['Max Humidity', laboratory.maximumHumidity],
    ['Code', laboratory.code], ['Business unit', laboratory.businessUnitName], ['Description', laboratory.description], ['Active', laboratory.active ? 'Yes' : 'No']];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break" style={{ whiteSpace: 'pre-wrap' }}>{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}
export default function LaboratoryPage({ laboratoryId, mode, canManage }) {
  const [laboratory, setLaboratory] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!laboratoryId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/administration/laboratories/${laboratoryId}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setLaboratory(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [laboratoryId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage labs.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!laboratoryId) return <LaboratoryForm />;
  if (!laboratory || laboratory.id !== laboratoryId.toLowerCase()) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Lab...</div></div>;
  return mode === 'view' ? <LaboratoryView laboratory={laboratory} /> : <LaboratoryForm key={laboratory.id} laboratory={laboratory} />;
}
