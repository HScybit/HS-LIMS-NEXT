'use client';

import { useEffect, useState } from 'react';
import MethodForm from './MethodForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function MethodView({ method }) {
  const rows = [['Name', method.name], ['UUID', method.uuid], ['Description', method.description], ['Decimal Places', method.decimalScale],
    ['Convert Number', method.parseNumber ? 'YES' : 'NO'], ['Allow access to', method.accessUsers.map((user) => user.name).join(', ')]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function MethodPage({ methodId, mode, canManage }) {
  const [method, setMethod] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!methodId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/methods/${methodId}`, { signal: controller.signal }).then((value) => { setMethod(value); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [methodId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage methods of analysis.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div></div>;
  if (!methodId) return <MethodForm />;
  if (!method) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Method of Analysis...</div></div>;
  return mode === 'view' ? <MethodView method={method} /> : <MethodForm key={method.id} method={method} />;
}
