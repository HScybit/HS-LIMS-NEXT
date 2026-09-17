'use client';

import { useEffect, useState } from 'react';
import InstrumentForm from './InstrumentForm.jsx';
import InstrumentDetail from './InstrumentDetail.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function InstrumentPage({ instrumentId, mode, canRead, canManage }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = canRead && (mode === 'view' || canManage);
  useEffect(() => {
    if (!permitted) return undefined;
    const controller = new AbortController();
    Promise.all([instrumentId ? apiRequest('/api/instruments/' + instrumentId, { signal: controller.signal }) : null,
      apiRequest('/api/instruments/service-types', { signal: controller.signal })]).then(([instrument, types]) => {
      if (!controller.signal.aborted) { setData({ instrument, serviceTypes: types.rows }); setError(''); }
    }).catch(failure => { if (!controller.signal.aborted) { setError(failure.message); setData(null); } });
    return () => controller.abort();
  }, [instrumentId, permitted, reload]);
  if (!permitted) return <div className="alert alert-warning m-4" role="alert">{canRead ? 'You do not have permission to manage Instruments.' : 'Instrument module access is required.'}</div>;
  if (error) return <div className="alert alert-warning m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div>;
  if (!data) return <div className="text-muted m-4" role="status">Loading Instrument...</div>;
  return mode === 'view' ? <InstrumentDetail {...data} canManage={canManage} /> : <InstrumentForm {...data} />;
}
