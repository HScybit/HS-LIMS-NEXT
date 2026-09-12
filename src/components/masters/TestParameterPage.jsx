'use client';

import { useEffect, useState } from 'react';
import TestParameterForm, { uncertaintyConfig } from './TestParameterForm.jsx';
import { SpreadsheetReadOnly } from './ParameterUncertainty.jsx';
import { uncertaintySpreadsheet } from '../../masters/parameter-grid.js';
import { apiRequest } from '../../lib/api-client.js';

function TestParameterView({ parameter }) {
  const rows = [['Order', parameter.order], ['Parameter Name', parameter.name], ['Description', parameter.description], ['Key', parameter.key],
    ['Lab Name', parameter.laboratoryName], ['Scheme Abbreviation', parameter.schemeAbbreviation]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
      {parameter.measurementUncertainty ? <tr><td className="text-muted fw-semibold py-2 px-3 w-25">Measurement Uncertainty</td><td className="py-2 px-3">
        <SpreadsheetReadOnly value={uncertaintySpreadsheet(parameter.measurementUncertainty)} cfg={uncertaintyConfig} />
      </td></tr> : null}
    </tbody></table></div>
  </div></div></div>;
}

export default function TestParameterPage({ parameterId, mode, canManage }) {
  const [parameter, setParameter] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!parameterId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/test-parameters/${parameterId}`, { signal: controller.signal }).then((value) => { setParameter(value); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [parameterId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage test parameters.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div></div>;
  if (!parameterId) return <TestParameterForm />;
  if (!parameter) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Test Parameter...</div></div>;
  return mode === 'view' ? <TestParameterView parameter={parameter} /> : <TestParameterForm key={parameter.id} parameter={parameter} />;
}
