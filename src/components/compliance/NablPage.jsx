'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import NablForm from './NablForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

const columns = [
  { key: 'parameterName', header: 'Parameter', filterable: false, sortable: false, format: (value, row) => [value, row.schemeAbbreviation].filter(Boolean).join(' - ') },
  { key: 'accredited', header: 'NABL', type: 'boolean', filterable: false, sortable: false, format: value => value ? 'NABL' : 'NON NABL' },
  { key: 'products', header: 'Products', filterable: false, sortable: false, format: value => value.map(item => item.name).join(', ') || '-' },
  { key: 'methods', header: 'MOAs', filterable: false, sortable: false, format: value => value.map(item => item.name).join(', ') || '-' },
];
function FileLink({ file }) {
  return file ? <a href={`${file.url}?view=1`} target="_blank" rel="noopener noreferrer">{file.originalName}</a> : '-';
}
function NablView({ certification, historical }) {
  const loadRows = useCallback(async ({ page, pageSize, search }) => {
    const needle = search.trim().toLowerCase(); const rows = certification.scopes.filter(row => !needle || [row.parameterName, row.schemeAbbreviation, ...row.products.map(item => item.name), ...row.methods.map(item => item.name)].some(text => text.toLowerCase().includes(needle)));
    return { totalCount: rows.length, rows: rows.slice((page - 1) * pageSize, page * pageSize).map(row => ({ ...row, _id: row.parameterId })) };
  }, [certification]);
  return <div className="container-fluid py-4">
    <div className="d-flex flex-wrap align-items-center gap-3 mb-3"><h1 className="h4 mb-0">NABL Certification</h1><span className="text-muted">Revision {certification.revision}</span>
      {certification.revision > 1 ? <Link href={`/nabl_certificates/${certification.id}/view?revision=${certification.revision - 1}`}>Previous revision</Link> : null}
      {historical ? <Link href={`/nabl_certificates/${certification.id}/view`}>Current revision</Link> : null}
    </div>
    <div className="card border-0 shadow-sm mb-4"><div className="card-body"><div className="table-responsive"><table className="table table-sm table-striped align-middle table-bordered mb-0"><tbody>
      {[['Valid From', certification.validFrom], ['Valid Till', certification.validTo], ['NABL Scope', <FileLink key="scope" file={certification.scopeFile} />], ['NABL Certificate', <FileLink key="certificate" file={certification.certificateFile} />]].map(([label, value]) => <tr key={label}><th className="text-muted fw-semibold py-2 px-3">{label}</th><td className="py-2 px-3 text-break">{value}</td></tr>)}
    </tbody></table></div></div></div>
    <div className="card border-0 shadow-sm"><div className="card-header bg-light py-2"><h6 className="mb-0">Accredition Data</h6></div><DataTable columns={columns} loadRows={loadRows} /></div>
    <p className="small text-muted mt-3">Saved by {certification.savedByName} · {new Date(certification.savedAt).toLocaleString()}{certification.active ? '' : ' · Deleted'}</p>
  </div>;
}
export default function NablPage({ certificationId, mode, canManage, canRead }) {
  const search = useSearchParams(); const revision = mode === 'view' ? search.get('revision') : null;
  const [record, setRecord] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' ? canRead : canManage;
  const key = `${certificationId}:${mode}:${revision ?? ''}`;
  useEffect(() => {
    if (!certificationId || !permitted) return undefined;
    const controller = new AbortController();
    const query = mode === 'edit' ? '?editing=1' : revision !== null ? `?revision=${encodeURIComponent(revision)}` : '';
    apiRequest(`/api/operations/nabl-certifications/${certificationId}${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setRecord({ key, value }); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [certificationId, mode, revision, permitted, reload, key]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to {mode === 'view' ? 'view' : 'manage'} NABL certifications.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!certificationId) return <NablForm />;
  if (!record || record.key !== key) return <div className="container-fluid py-4"><div role="status" className="text-muted">Loading NABL certification...</div></div>;
  return mode === 'view' ? <NablView certification={record.value} historical={revision !== null} /> : <NablForm key={`${key}:${record.value.revision}`} certification={record.value} />;
}
