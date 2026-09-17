'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import { vendorFormFields } from '../../masters/vendor-fields.js';
import { vendorFormDraft, vendorFormErrors } from '../../masters/vendor-form.js';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';
import MasterCustomFields from './MasterCustomFields.jsx';
import { customFieldSubmittedValue, customFieldValidationError, customFieldNeedsGeneration } from '../../custom-fields/form-values.js';
import { masterCustomFieldDraft } from '../../masters/custom-field-draft.js';
import { loadMasterFieldLookupSources } from '../../masters/custom-field-lookup-client.js';

const emptyFields = [];

export default function VendorForm({ vendor }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => vendorFormDraft(vendor));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const [custom, setCustom] = useState({ fields: [], values: {}, lookupSources: new Map() });
  const { fields: customFields, values: customValues, lookupSources } = custom;
  const lookupCache = useRef(new Map()); const fieldLoad = useRef(null); const fieldWork = useRef(false); const uploadBusy = useRef(new Set());
  const [saveUnknown, setSaveUnknown] = useState(false);
  const [customLoading, setCustomLoading] = useState(true); const [customLoadError, setCustomLoadError] = useState('');
  const [customReload, setCustomReload] = useState(0);
  const [uploadingFields, setUploadingFields] = useState(() => new Set()); const [generatingId, setGeneratingId] = useState('');
  const blocked = saving || Boolean(generatingId) || uploadingFields.size > 0;
  const canRefreshFields = !blocked && !saveUnknown;
  const reloadFields = useCallback(() => setCustomReload(value => value + 1), []);
  const storedFields = vendor?.customFields ?? emptyFields;

  const from = search.get('from'); const returnPath = from && /^\/vendor_masters(?:\?[^#]*)?$/.test(from) ? from : '/vendor_masters';
  useEffect(() => {
    if (!canRefreshFields) return undefined;
    const controller = new AbortController(); fieldLoad.current = controller;
    const canPublish = () => !controller.signal.aborted && !fieldWork.current && !saveRequest.current?.pending && !uploadBusy.current.size;
    apiRequest('/api/masters/vendors/custom-fields', { signal: controller.signal }).then(async ({ fields, organizationId }) => {
      const sources = await loadMasterFieldLookupSources('vendor', fields, lookupCache.current, { signal: controller.signal, organizationId });
      if (!canPublish()) return;
      lookupCache.current = sources;
      setCustom(current => ({ fields, values: masterCustomFieldDraft(fields, storedFields, current.fields, current.values), lookupSources: sources }));
      setCustomLoadError(''); setCustomLoading(false);
    }).catch(failure => {
      if (canPublish()) { setCustomLoadError(failure.message); setCustomLoading(false); }
      controller.abort();
    }).finally(() => { if (fieldLoad.current === controller) fieldLoad.current = null; });
    return () => { controller.abort(); if (fieldLoad.current === controller) fieldLoad.current = null; };
  }, [canRefreshFields, storedFields, customReload]);
  useEffect(() => {
    if (!canRefreshFields) return undefined;
    const refresh = () => { if (!fieldLoad.current && document.visibilityState !== 'hidden') reloadFields(); };
    const timer = window.setInterval(refresh, 10_000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [canRefreshFields, reloadFields]);
  const onUploadBusy = useCallback((fieldId, busy) => {
    if (busy) uploadBusy.current.add(fieldId); else uploadBusy.current.delete(fieldId);
    setUploadingFields(new Set(uploadBusy.current));
  }, []);
  function clearFieldError(field) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const { [field]: _error, ...rest } = current; return rest;
    });
  }
  const change = (field) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value; setDraft((current) => ({ ...current, [field]: value })); clearFieldError(field);
  };
  function changeCustomField(fieldId, value) {
    if (Array.isArray(value) && value.length > 500) { setFieldErrors(current => ({ ...current, [fieldId]: 'Select at most 500 items.' })); return; }
    setCustom(current => ({ ...current, values: { ...current.values, [fieldId]: value } })); clearFieldError(fieldId);
  }
  function capture(values) {
    if (!customFields.length) return {};
    return { customFields: customFields.map((field) => ({ fieldId: field.id, fieldRevision: field.revision, value: customFieldSubmittedValue(values[field.id]) })),
      ...(customFields.some((field) => ['date', 'date_time'].includes(field.fieldType))
        ? { customFieldTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}) };
  }
  async function generate(values, fieldId) {
    if (!fieldId && !customFields.some((field) => customFieldNeedsGeneration(field, vendor ? 'edit' : 'create', values[field.id]))) return values;
    const result = await apiRequest('/api/masters/vendors/custom-field-generation', { method: 'POST', body: {
      vendorId: vendor?.id ?? null, vendor: draft, ...capture(values), fieldId: fieldId ?? null,
    } });
    const next = { ...values };
    for (const item of result.values) next[item.fieldId] = item.value;
    setCustom(current => ({ ...current, values: next })); return next;
  }
  async function generateField(field) {
    if (blocked || customLoading || customLoadError) return;
    fieldWork.current = true; setGeneratingId(field.id); setError('');
    try { await generate(customValues, field.id); clearFieldError(field.id); }
    catch (failure) { setError(failure.message); }
    finally { fieldWork.current = false; setGeneratingId(''); }
  }
  function saveBody(values) {
    return { ...draft, ...capture(values), id: vendor?.id ?? newId.current, revision: vendor?.revision ?? 0 };
  }
  async function save(event) {
    event.preventDefault(); if (blocked || customLoading || customLoadError) return;
    fieldWork.current = true; setSaving(true); setError('');
    let values;
    const replay = saveRequest.current?.content === JSON.stringify(saveBody(customValues));
    try { values = replay ? customValues : await generate(customValues); }
    catch (failure) { fieldWork.current = false; setError(failure.message); setSaving(false); return; }
    const problems = vendorFormErrors(draft);
    for (const field of customFields) {
      const problem = customFieldValidationError(field, values[field.id]); if (problem) problems[field.id] = problem;
    }
    setFieldErrors(problems); if (Object.keys(problems).length) { fieldWork.current = false; setSaving(false); return; }
    newId.current ??= crypto.randomUUID();
    const body = saveBody(values);
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    saveRequest.current.pending = true;
    try {
      await apiRequest('/api/masters/vendors', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      saveRequest.current.pending = false; setSaveUnknown(false); router.push(returnPath);
    } catch (failure) {
      saveRequest.current.pending = ![400, 401, 403, 404, 409, 413, 422].includes(failure.status);
      setSaveUnknown(saveRequest.current.pending); setError(failure.message); setSaving(false);
    } finally { fieldWork.current = false; }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      {vendor && vendor.contacts.length > 1
        ? <p className="text-muted small">These fields edit the displayed contact. Additional contacts are retained.</p> : null}
      {vendorFormFields.map(field => <div className="mb-3" key={field.key}>
        <FormElement type="text"
          label={field.label} mandatory={field.required} helperText={field.helperText} message={fieldErrors[field.key]} messageTone="error"
          inputProps={{ id: field.source, name: field.source, value: draft[field.key], onChange: change(field.key), disabled: blocked,
            placeholder: field.placeholder ?? field.label, maxLength: field.maximum, type: field.type === 'number' || field.type === 'email' ? field.type : undefined,
            step: field.type === 'number' ? 'any' : undefined }} />
      </div>)}
      <MasterCustomFields kind="vendor" fields={customFields} loading={customLoading} loadError={customLoadError} values={customValues} storedFields={storedFields} lookupSources={lookupSources}
        errors={fieldErrors} disabled={blocked} generatingId={generatingId} onChange={changeCustomField} onBusy={onUploadBusy} onGenerate={generateField}
        onReload={reloadFields} />
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={blocked} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={blocked || customLoading || Boolean(customLoadError)}>{saving ? 'Saving...' : vendor ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
