'use client';

import { useEffect, useState } from 'react';
import ChecklistForm from './ChecklistForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function ChecklistPage({ checklistId, allowed, mode = 'edit' }) {
  const [checklist, setChecklist] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!checklistId || !allowed) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/checklists/${checklistId}`, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setChecklist(value); setError(''); }
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [checklistId, allowed, reload]);
  if (!allowed) return <div className="alert alert-warning m-4" role="alert">You do not have permission to {mode === 'view' ? 'view' : 'manage'} checklists.</div>;
  if (error) return <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div>;
  if (!checklistId) return <ChecklistForm />;
  if (!checklist) return <p className="text-muted m-4" role="status">Loading Checklist...</p>;
  if (mode !== 'view') return <ChecklistForm key={checklist.id} checklist={checklist} />;
  const rows = [['Name', checklist.name], ['Line Items', checklist.items.map((item) => item.prompt).join(', ')], ['Is Active?', checklist.isActive ? 'Yes' : 'No']];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4"><div className="table-responsive">
    <table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value !== '').map(([label, value]) => <tr key={label}><th className="text-muted fw-semibold py-2 px-3 w-25">{label}</th>
        <td className="py-2 px-3"><div className="text-break">{value}</div></td></tr>)}
    </tbody></table>
  </div></div></div></div>;
}
