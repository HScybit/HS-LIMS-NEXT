'use client';

import { useEffect, useState } from 'react';
import CustomerForm from './CustomerForm.jsx';
import { customerFormFields } from '../../masters/customer-fields.js';
import { apiRequest } from '../../lib/api-client.js';

function CustomerView({ customer }) {
  const rows = customerFormFields.map(field => {
    const value = customer[field.key];
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

export default function CustomerPage({ customerId, mode, canRead, canManage }) {
  const [customer, setCustomer] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = canRead && (mode === 'view' || canManage);
  useEffect(() => {
    if (!customerId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/customers/${customerId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setCustomer(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [customerId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{canRead ? 'You do not have permission to manage Customers.' : 'Customer module access is required.'}</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!customerId) return <CustomerForm />;
  if (!customer) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Customer...</div></div>;
  return mode === 'view' ? <CustomerView customer={customer} /> : <CustomerForm key={customer.id} customer={customer} />;
}
