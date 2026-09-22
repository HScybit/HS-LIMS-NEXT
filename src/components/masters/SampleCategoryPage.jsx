'use client';

import { useEffect, useState } from 'react';
import SampleCategoryForm from './SampleCategoryForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function SampleCategoryView({ category }) {
  const rows = [['Name', category.name], ['Description', category.description], ['Abbreviation', category.abbreviation],
    ['Retention Days', category.retentionDays], ['Estimated Time in Days', category.estimatedTimeInDays],
    ['Enable Events', category.enableEvents ? 'Yes' : 'No'], ['Enable Reissue', category.enableReissue ? 'Yes' : 'No'],
    ['Workflow', category.workflowName], ['Users', category.users?.map((user) => user.name).join(', ')],
    ['Custom Fields', category.includedFields?.map((field) => field.label).join(', ')],
    ...[['sample', 'Sample Template'], ['datasheet', 'Datasheet Template'], ['report', 'Report Template'], ['label', 'Label Template']]
      .map(([purpose, label]) => [label, category.templates?.[purpose] ? category.templateNames?.[purpose] ?? category.templates[purpose] : null]),
    ['Created At', category.createdAt ? new Date(category.createdAt).toLocaleDateString('en-GB') : null]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function SampleCategoryPage({ categoryId, mode, canManage }) {
  const [category, setCategory] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!categoryId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/sample-categories/${categoryId}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setCategory(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [categoryId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage Sample Categories.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!categoryId) return <SampleCategoryForm />;
  if (!category) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Sample Category...</div></div>;
  return mode === 'view' ? <SampleCategoryView category={category} /> : <SampleCategoryForm key={category.id} category={category} />;
}
