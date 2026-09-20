'use client';

import { useEffect, useState } from 'react';
import MaterialCategoryForm from './MaterialCategoryForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function MaterialCategoryView({ category }) {
  const rows = [['Name', category.name], ['Description', category.description], ['Reusable', category.reusable ? 'Yes' : 'No'],
    ['Expirable', category.expirable ? 'Yes' : 'No'], ['Created At', new Date(category.createdAt).toLocaleDateString('en-GB')]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function MaterialCategoryPage({ categoryId, mode, canManage }) {
  const [category, setCategory] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!categoryId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/material-categories/${categoryId}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setCategory(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [categoryId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage material categories.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!categoryId) return <MaterialCategoryForm />;
  if (!category) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Material Category...</div></div>;
  return mode === 'view' ? <MaterialCategoryView category={category} /> : <MaterialCategoryForm key={category.id} category={category} />;
}
