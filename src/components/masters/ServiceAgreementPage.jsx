'use client';

import { useEffect, useState } from 'react';
import ServiceAgreementForm from './ServiceAgreementForm.jsx';
import { serviceAgreementDateDisplay, serviceAgreementServices } from '../../masters/service-agreement-fields.js';
import { apiRequest } from '../../lib/api-client.js';

function ServiceAgreementView({ agreement }) {
  const rows = [['Vendor', agreement.vendorName], ['Equipment(s)', agreement.instruments.map(item => item.name).join(', ')],
    ['Start Date', serviceAgreementDateDisplay(agreement.startDate)], ['End Date', serviceAgreementDateDisplay(agreement.endDate)],
    ['Services Included', agreement.includedServices.map(code => serviceAgreementServices.find(service => service.value === code)?.label ?? code).join(', ')],
    ['No of Services', agreement.noOfServices], ['Cost (in Rs.)', agreement.cost], ['Notes', agreement.notes], ['In Effect', agreement.inEffect ? 'Yes' : 'No'],
    ['Attachment', agreement.attachment ? <a href={agreement.attachment.url} download={agreement.attachment.originalName}>{agreement.attachment.originalName}</a> : null]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value !== null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break" style={{ whiteSpace: 'pre-wrap' }}>{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function ServiceAgreementPage({ agreementId, mode, canRead, canManage }) {
  const [agreement, setAgreement] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = canRead && (mode === 'view' || canManage);
  useEffect(() => {
    if (!agreementId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/service-agreements/${agreementId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setAgreement(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [agreementId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{canRead ? 'You do not have permission to manage Service Agreements.' : 'Service Agreement module access is required.'}</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!agreementId) return <ServiceAgreementForm />;
  if (!agreement) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Service Agreement...</div></div>;
  return mode === 'view' ? <ServiceAgreementView agreement={agreement} /> : <ServiceAgreementForm key={agreement.id} agreement={agreement} />;
}
