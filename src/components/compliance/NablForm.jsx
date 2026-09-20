'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import NablFileField from './NablFileField.jsx';
import NablScopes from './NablScopes.jsx';
import { parseCalendarDate } from '../ui/date-input.js';
import { apiRequest } from '../../lib/api-client.js';

export default function NablForm({ certification }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null); const pending = useRef(false); const filesPending = useRef(new Set());
  const [validFrom, setValidFrom] = useState(certification?.validFrom ?? ''); const [validTo, setValidTo] = useState(certification?.validTo ?? '');
  const [scopeFile, setScopeFile] = useState(certification?.scopeFile ?? null); const [certificateFile, setCertificateFile] = useState(certification?.certificateFile ?? null);
  const [scopes, setScopes] = useState(() => Object.fromEntries((certification?.scopes ?? []).map(row => [row.parameterId, row])));
  const retainedIds = useMemo(() => (certification?.scopes ?? []).map(row => row.parameterId), [certification]);
  const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false); const [error, setError] = useState(''); const [invalid, setInvalid] = useState({}); const [stale, setStale] = useState(false);
  const from = search.get('from'); const returnPath = from && /^\/nabl_certificates(?:\?[^#]*)?$/.test(from) ? from : '/nabl_certificates';
  const onBusy = useCallback((name, busy) => {
    if (busy) filesPending.current.add(name); else filesPending.current.delete(name); setUploading(filesPending.current.size > 0);
  }, []);
  const changeScope = useCallback((parameter, key, value) => {
    setScopes(current => ({ ...current, [parameter.id]: { ...(current[parameter.id] ?? { parameterId: parameter.id, products: [], methods: [] }), [key]: value } }));
  }, []);
  async function save(event) {
    event.preventDefault(); if (pending.current || filesPending.current.size) return;
    const errors = {}; const dates = {};
    for (const [key, value, label] of [['validFrom', validFrom, 'Valid From Date'], ['validTo', validTo, 'Valid To Date']]) {
      const parsed = parseCalendarDate(value);
      if (!value) errors[key] = `${label} is required`; else if (!parsed) errors[key] = `${label} must be a valid date`; else dates[key] = parsed.iso;
    }
    if (!errors.validFrom && !errors.validTo && dates.validTo < dates.validFrom) errors.validTo = 'Valid To Date must be on or after Valid From Date.';
    if (Object.keys(errors).length) { setInvalid(errors); return; }
    if (Object.keys(scopes).length > 2000) { setError('NABL scope can contain at most 2000 parameter rows.'); return; }
    newId.current ??= crypto.randomUUID();
    const body = { id: certification?.id ?? newId.current, revision: certification?.revision ?? 0, ...dates, scopeFileId: scopeFile?.id ?? null, certificateFileId: certificateFile?.id ?? null,
      scopes: Object.values(scopes).map(row => ({ parameterId: row.parameterId, productIds: row.products.map(item => item.id), methodIds: row.methods.map(item => item.id) })) };
    const content = JSON.stringify(body); if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    pending.current = true; setSaving(true); setError('');
    try { await apiRequest('/api/operations/nabl-certifications', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } }); router.push(returnPath); }
    catch (failure) { setError(failure.message); setStale(failure.code === 'stale_nabl_certification'); pending.current = false; setSaving(false); }
  }
  return <div className="container-fluid py-4">
    {error ? <div role="alert" className="alert alert-danger">{error}{stale ? <button type="button" className="btn btn-link" onClick={() => window.location.reload()}>Reload certification</button> : null}</div> : null}
    <form id="nabl-certification-form" onSubmit={save} noValidate className="smplfy-nabl-certification-form">
      <div className="card border-0 shadow-sm mb-4"><div className="card-header bg-light border-bottom py-2"><h6 className="mb-0">Listing Rules</h6></div><div className="card-body">
        <div className="row"><div className="col-md-6 mb-3"><FormElement type="date" mandatory label="Valid From Date" message={invalid.validFrom} messageTone="error"
          inputProps={{ name: 'validFrom', value: validFrom, calendarOnly: true, disabled: saving, onChange: event => { setValidFrom(event.target.value); setInvalid(current => ({ ...current, validFrom: '' })); } }} /></div>
        <div className="col-md-6 mb-3"><FormElement type="date" mandatory label="Valid To Date" message={invalid.validTo} messageTone="error"
          inputProps={{ name: 'validTo', value: validTo, calendarOnly: true, disabled: saving, onChange: event => { setValidTo(event.target.value); setInvalid(current => ({ ...current, validTo: '' })); } }} /></div></div>
        <div className="row"><div className="col-md-6"><NablFileField name="scope" label="NABL Scope" value={scopeFile} disabled={saving} onChange={setScopeFile} onBusy={onBusy} /></div>
          <div className="col-md-6"><NablFileField name="certificate" label="NABL Certificate" value={certificateFile} disabled={saving} onChange={setCertificateFile} onBusy={onBusy} /></div></div>
      </div></div>
    </form>
    <div className="card border-0 shadow-sm mb-4"><div className="card-header bg-light border-bottom py-2"><h6 className="mb-0">Accredition Data</h6></div><div className="card-body p-0">
      <NablScopes scopes={scopes} change={changeScope} disabled={saving} retainedIds={retainedIds} />
    </div></div>
    <div className="d-flex justify-content-end gap-2 border-top pt-3"><SecondaryButton disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
      <PrimaryButton type="submit" form="nabl-certification-form" disabled={saving || uploading}>{saving ? 'Saving...' : certification ? 'Update' : 'Create'}</PrimaryButton></div>
  </div>;
}
