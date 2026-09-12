'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import Offcanvas from '../ui/Offcanvas.jsx';
import { apiRequest } from '../../lib/api-client.js';

const selections = [['headerDocumentId', 'Non NABL Header', 'header', 'select-header'], ['nablHeaderDocumentId', 'NABL Header', 'header', 'select-nabl-header'],
  ['footerDocumentId', 'Non-NABL Footer', 'footer', 'select-footer'], ['nablFooterDocumentId', 'NABL Footer', 'footer', 'select-nabl-footer']];

export default function TemplateSettingsPanel({ model, onCommand, onClose, busy }) {
  const drawer = useRef(null);
  const [values, setValues] = useState(() => Object.fromEntries(selections.map(([key]) => [key, model.version[key] ?? ''])));
  const [options, setOptions] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('/api/templates/report-assets', { signal: controller.signal }).then((data) => setOptions(data.items)).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, []);
  async function save(event) {
    event.preventDefault(); if (busy || !options) return;
    if (await onCommand({ type: 'setReportAssets', ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value || null])) })) drawer.current?.hide();
  }
  return <Offcanvas ref={drawer} title="Settings" subtitle="Template" className="template-settings-panel" onClose={onClose}>
    <form style={{ display: 'contents' }} onSubmit={save}>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <section className="template-settings-summary">
        <span><strong>{Number(Boolean(values.headerDocumentId)) + Number(Boolean(values.nablHeaderDocumentId))}</strong><small>Headers</small></span>
        <span><strong>{Number(Boolean(values.footerDocumentId)) + Number(Boolean(values.nablFooterDocumentId))}</strong><small>Footers</small></span>
      </section>
      {selections.map(([key, label, type, className]) => <label key={key} className="template-settings-field"><span>{label}</span>
        <select className={`form-control ${className}`} value={values[key]} disabled={busy || !options} onChange={(event) => {
          const value = event.currentTarget.value; setValues((previous) => ({ ...previous, [key]: value }));
        }}>
          <option value="">{type === 'header' ? 'No Header' : 'No Footer'}</option>
          {values[key] && options && !options.some((option) => option.id === values[key]) ? <option value={values[key]}>Unavailable {type}</option> : null}
          {(options ?? []).filter((option) => option.type === type).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label>)}
      <button type="submit" className="template-settings-save" disabled={busy || !options}><AppIcon name="save" size={17} /><span>{busy ? 'Saving' : 'Save Settings'}</span></button>
    </form>
  </Offcanvas>;
}
