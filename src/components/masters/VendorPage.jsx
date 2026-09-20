'use client';

import { useEffect, useState } from 'react';
import VendorForm from './VendorForm.jsx';
import { vendorFormFields } from '../../masters/vendor-fields.js';
import { apiRequest } from '../../lib/api-client.js';

function VendorView({ vendor }) {
  const rows = vendorFormFields.map(field => {
    const value = vendor[field.key];
    return [field.label, field.type === 'boolean' ? value ? 'Yes' : 'No' : field.type === 'select'
      ? field.options.find(option => option.value === value)?.label ?? value : value];
  });
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break" style={{ whiteSpace: 'pre-wrap' }}>{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function VendorPage({ vendorId, mode, canRead, canManage }) {
  const [vendor, setVendor] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = canRead && (mode === 'view' || canManage);
  useEffect(() => {
    if (!vendorId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/vendors/${vendorId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setVendor(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [vendorId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{canRead ? 'You do not have permission to manage Vendors.' : 'Vendor module access is required.'}</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!vendorId) return <VendorForm />;
  if (!vendor) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Vendor...</div></div>;
  return mode === 'view' ? <VendorView vendor={vendor} /> : <VendorForm key={vendor.id} vendor={vendor} />;
}
