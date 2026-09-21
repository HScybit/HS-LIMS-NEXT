'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { customerFormFields } from '../../masters/customer-fields.js';
import { customerFormDraft, customerFormErrors, customerFormInput } from '../../masters/customer-form.js';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage, { FormSection, FormField } from '../ui/FormPage.jsx';
import { apiRequest } from '../../lib/api-client.js';
import MasterCustomFields from './MasterCustomFields.jsx';
import { customFieldSubmittedValue, customFieldValidationError, customFieldNeedsGeneration } from '../../custom-fields/form-values.js';
import { masterCustomFieldDraft } from '../../masters/custom-field-draft.js';
import { loadMasterFieldLookupSources } from '../../masters/custom-field-lookup-client.js';

const emptyFields = [];

export default function CustomerForm({ customer }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => customerFormDraft(customer));
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
  const storedFields = customer?.customFields ?? emptyFields;

  const from = search.get('from'); const returnPath = from && /^\/customer_masters(?:\?[^#]*)?$/.test(from) ? from : '/customer_masters';
  useEffect(() => {
    if (!canRefreshFields) return undefined;
    const controller = new AbortController(); fieldLoad.current = controller;
    const canPublish = () => !controller.signal.aborted && !fieldWork.current && !saveRequest.current?.pending && !uploadBusy.current.size;
    apiRequest('/api/masters/customers/custom-fields', { signal: controller.signal }).then(async ({ fields, organizationId }) => {
      const sources = await loadMasterFieldLookupSources('customer', fields, lookupCache.current, { signal: controller.signal, organizationId });
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
    if (!fieldId && !customFields.some((field) => customFieldNeedsGeneration(field, customer ? 'edit' : 'create', values[field.id]))) return values;
    const result = await apiRequest('/api/masters/customers/custom-field-generation', { method: 'POST', body: {
      customerId: customer?.id ?? null, customer: draft, ...capture(values), fieldId: fieldId ?? null,
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
    return { ...customerFormInput(draft), ...capture(values), id: customer?.id ?? newId.current, revision: customer?.revision ?? 0 };
  }
  async function save(event) {
    event.preventDefault(); if (blocked || customLoading || customLoadError) return;
    fieldWork.current = true; setSaving(true); setError('');
    let values;
    const replay = saveRequest.current?.content === JSON.stringify(saveBody(customValues));
    try { values = replay ? customValues : await generate(customValues); }
    catch (failure) { fieldWork.current = false; setError(failure.message); setSaving(false); return; }
    const problems = customerFormErrors(draft);
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
      await apiRequest('/api/masters/customers', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      saveRequest.current.pending = false; setSaveUnknown(false); router.push(returnPath);
    } catch (failure) {
      saveRequest.current.pending = ![400, 401, 403, 404, 409, 413, 422].includes(failure.status);
      setSaveUnknown(saveRequest.current.pending); setError(failure.message); setSaving(false);
    } finally { fieldWork.current = false; }
  }
  // A long field earns the full width; the rest pair up.
  const span = (field) => (['textarea', 'boolean'].includes(field.type) ? 12 : 6);
  return <FormPage title={customer ? 'Edit Customer' : 'New Customer'} backTo={returnPath} backLabel="Back to customers"
    formId="customer-form" onSubmit={save} saving={saving} disabled={blocked || customLoading || Boolean(customLoadError)}
    submitLabel={customer ? 'Update' : 'Create'} error={error}
    actions={<SecondaryButton leftIcon="close" disabled={blocked} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>}>
    {customer && (customer.contacts.length > 1 || ['shipping', 'billing'].some(type => customer.addresses.filter(address => address.addressType === type).length > 1))
      ? <p className="text-muted small">These fields edit the displayed contact and default addresses. Additional contacts and addresses are retained.</p> : null}
    <FormSection title="Customer Details">
      {customerFormFields.map(field => <FormField span={span(field)} key={field.key}>
        {field.type === 'boolean' ? <div className="smplfy-checkbox-field">
          <Checkbox id={field.source} name={field.source} checked={draft[field.key]} disabled={blocked} ariaLabel={field.label}
            onChange={value => { setDraft(current => ({ ...current, [field.key]: value })); clearFieldError(field.key); }} />
          <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={field.source}>{field.label}</label></div>
        </div> : <FormElement type={field.type === 'select' ? 'dropdown' : field.type === 'textarea' ? 'textarea' : 'text'}
          label={field.label} mandatory={field.required} helperText={field.helperText} message={fieldErrors[field.key]} messageTone="error"
          inputProps={{ id: field.source, name: field.source, value: draft[field.key], onChange: change(field.key), disabled: blocked,
            placeholder: field.placeholder ?? field.label, maxLength: field.maximum, type: field.type === 'number' || field.type === 'email' ? field.type : undefined,
            min: field.min, max: field.max, step: field.type === 'number' ? field.step ?? 'any' : undefined, rows: field.type === 'textarea' ? 3 : undefined,
            ...(field.type === 'select' ? { options: field.options } : {}) }} />}
      </FormField>)}
    </FormSection>
    <FormSection last>
      <FormField span={12}>
        <MasterCustomFields kind="customer" fields={customFields} loading={customLoading} loadError={customLoadError} values={customValues} storedFields={storedFields} lookupSources={lookupSources}
          errors={fieldErrors} disabled={blocked} generatingId={generatingId} onChange={changeCustomField} onBusy={onUploadBusy} onGenerate={generateField}
          onReload={reloadFields} />
      </FormField>
    </FormSection>
  </FormPage>;
}
