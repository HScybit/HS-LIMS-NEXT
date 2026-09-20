'use client';

import { useEffect, useState } from 'react';
import ProductForm from './ProductForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function ProductView({ product }) {
  const rows = [['Name', product.name], ['Description', product.description], ['Abbreviation', product.abbreviation], ['Key', product.key],
    ['Job Template', product.jobTemplateName ?? product.jobTemplateId], ['Tags', product.tags.map((tag) => tag.name ?? tag.id).join(', ')]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function ProductPage({ productId, mode, canManage }) {
  const [product, setProduct] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!productId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/products/${productId}`, { signal: controller.signal }).then((value) => { setProduct(value); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [productId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage products.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div></div>;
  if (!productId) return <ProductForm />;
  if (!product) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Product...</div></div>;
  return mode === 'view' ? <ProductView product={product} /> : <ProductForm key={product.id} product={product} />;
}
