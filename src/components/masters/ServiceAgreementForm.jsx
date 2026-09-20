'use client';

import { Profiler, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import ServiceAgreementChoice from './ServiceAgreementChoice.jsx';
import ServiceAgreementFile from './ServiceAgreementFile.jsx';
import { serviceAgreementServices } from '../../masters/service-agreement-fields.js';
import { serviceAgreementFormBody, serviceAgreementFormDraft, serviceAgreementFormErrors } from '../../masters/service-agreement-form.js';
import { apiRequest } from '../../lib/api-client.js';

export default function ServiceAgreementForm({ agreement }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null); const busy = useRef(false);
  const [draft, setDraft] = useState(() => serviceAgreementFormDraft(agreement)); const [attachment, setAttachment] = useState(agreement?.attachment ?? null);
  const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false); const [saveUnknown, setSaveUnknown] = useState(false);
  const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const from = search.get('from'); const returnPath = from && /^\/service_agreements(?:\?[^#]*)?$/.test(from) ? from : '/service_agreements';
  const blocked = saving || uploading; const disabled = blocked || saveUnknown;
  function changeValue(key, value) {
    if (disabled) return;
    if (key === 'instrumentIds' && value.length > 500) { setFieldErrors(current => ({ ...current, instrumentIds: 'Select at most 500 Instruments.' })); return; }
    setDraft(current => ({ ...current, [key]: value }));
    setFieldErrors(current => { const { [key]: _error, ...rest } = current; return rest; });
  }
  const change = key => event => changeValue(key, event.target.value);
  async function save(event) {
    event.preventDefault(); if (busy.current || uploading) return;
    const problems = serviceAgreementFormErrors(draft); setFieldErrors(problems); if (Object.keys(problems).length) return;
    busy.current = true; setSaving(true); setError(''); newId.current ??= crypto.randomUUID();
    const body = { ...serviceAgreementFormBody(draft), id: agreement?.id ?? newId.current, revision: agreement?.revision ?? 0 };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    try {
      await apiRequest('/api/masters/service-agreements', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      setSaveUnknown(false); router.push(returnPath);
    } catch (failure) {
      setSaveUnknown(![400, 401, 403, 404, 409, 413, 422].includes(failure.status)); setError(failure.message); setSaving(false);
    } finally { busy.current = false; }
  }
  return <Profiler id="service-agreement-form" onRender={(_id, phase, duration, _base, start) => performance.measure(`service-agreement:react-${phase}`, { start, duration })}><div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}{saveUnknown ? <p className="mb-0 mt-1">Retry saving to confirm whether your changes were saved.</p> : null}</div> : null}
      <div className="mb-3"><ServiceAgreementChoice kind="vendors" id="vendor_id" label="Vendor" value={draft.vendorId} placeholder="Select Vendor"
        disabled={disabled} error={fieldErrors.vendorId} retained={agreement ? [{ id: agreement.vendorId, name: agreement.vendorName }] : undefined} onChange={value => changeValue('vendorId', value)} /></div>
      <div className="mb-3"><ServiceAgreementChoice kind="instruments" id="equipment_ids" label="Equipment(s)" value={draft.instrumentIds} placeholder="Select Equipment(s)" multiple
        disabled={disabled} error={fieldErrors.instrumentIds} retained={agreement?.instruments} onChange={value => changeValue('instrumentIds', value)} /></div>
      {[['startDate', 'start_date', 'Start Date', 'start'], ['endDate', 'end_date', 'End Date', 'end']].map(([key, id, label, word]) => <div className="mb-3" key={key}>
        <FormElement type="date" label={label} mandatory helperText={`The effective ${word} date of service agreement`} message={fieldErrors[key]} messageTone="error"
          inputProps={{ id, value: draft[key], onChange: change(key), disabled, calendarOnly: true, min: '0001-01-01', max: '9999-12-31' }} />
      </div>)}
      <div className="mb-3"><FormElement type="searchable-select" label="Services Included" helperText="Vendors are offered for these service types on the selected equipment."
        inputProps={{ id: 'included_services', multiple: true, options: serviceAgreementServices, value: draft.includedServices, disabled, placeholder: 'Select services',
          onChange: value => changeValue('includedServices', value) }} /></div>
      {[['noOfServices', 'no_of_services', 'No of Services', 'No of Services'], ['cost', 'cost', 'Cost (in Rs.)', 'Total Balance (in Rs.)']].map(([key, id, label, placeholder]) => <div className="mb-3" key={key}>
        <FormElement label={label} message={fieldErrors[key]} messageTone="error" inputProps={{ id, type: 'number', value: draft[key], placeholder, onChange: change(key), disabled,
          min: 0, step: key === 'noOfServices' ? 1 : 'any', max: key === 'noOfServices' ? 2_147_483_647 : undefined }} />
      </div>)}
      <div className="mb-3"><FormElement type="textarea" label="Notes" message={fieldErrors.notes} messageTone="error"
        inputProps={{ id: 'notes', value: draft.notes, placeholder: 'Notes and Summary', rows: 5, maxLength: 10000, onChange: change('notes'), disabled }} /></div>
      <div className="mb-3 smplfy-checkbox-field"><Checkbox id="in_effect" checked={draft.inEffect} ariaLabel="In Effect" disabled={disabled} onChange={value => changeValue('inEffect', value)} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="in_effect">In Effect</label></div>
      </div>
      <div className="mb-3"><ServiceAgreementFile value={attachment} disabled={saving || saveUnknown} onBusy={setUploading}
        onChange={value => { setAttachment(value); setDraft(current => ({ ...current, attachmentFileId: value?.id ?? null })); }} /></div>
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={blocked} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={blocked}>{saving ? 'Saving...' : agreement ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div></Profiler>;
}
