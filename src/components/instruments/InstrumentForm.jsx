'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import { instrumentFormDraft, instrumentFormErrors, instrumentServiceErrors, instrumentFormSubmission, isBreakdownService } from '../../instruments/form.js';
import InstrumentChoice from './InstrumentChoice.jsx';
import Stepper from '../ui/Stepper.jsx';
import '../../styles/new-instrument-page.scss';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';
import MasterCustomFields from '../masters/MasterCustomFields.jsx';
import { customFieldSubmittedValue, customFieldValidationError, customFieldNeedsGeneration } from '../../custom-fields/form-values.js';
import { masterCustomFieldDraft } from '../../masters/custom-field-draft.js';
import { loadCustomFieldLookupSources } from '../../custom-fields/lookup-client.js';

const emptyFields = [];

export default function InstrumentForm({ instrument, serviceTypes }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [step, setStep] = useState(0);
  const steps = ['Basic Details', ...serviceTypes.map(type => `${type.label} Details`), 'Additional Details'];
  const [draft, setDraft] = useState(() => instrumentFormDraft(instrument, serviceTypes));
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
  const storedFields = instrument?.customFields ?? emptyFields;

  const from = search.get('from'); const returnPath = from && /^\/equipments(?:\?[^#]*)?$/.test(from) ? from : '/equipments';
  useEffect(() => {
    if (!canRefreshFields) return undefined;
    const controller = new AbortController(); fieldLoad.current = controller;
    const canPublish = () => !controller.signal.aborted && !fieldWork.current && !saveRequest.current?.pending && !uploadBusy.current.size;
    apiRequest('/api/instruments/custom-fields', { signal: controller.signal }).then(async ({ fields, organizationId }) => {
      const sources = await loadCustomFieldLookupSources(fields, '/api/instruments/custom-fields/lookup-options', lookupCache.current, { signal: controller.signal, organizationId });
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
    if (!fieldId && !customFields.some((field) => customFieldNeedsGeneration(field, instrument ? 'edit' : 'create', values[field.id]))) return values;
    const result = await apiRequest('/api/instruments/custom-field-generation', { method: 'POST', body: {
      instrumentId: instrument?.id ?? null, instrument: instrumentFormSubmission(draft), ...capture(values), fieldId: fieldId ?? null,
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
    return { ...instrumentFormSubmission(draft), ...capture(values), id: instrument?.id ?? newId.current, revision: instrument?.revision ?? 0 };
  }
  async function save(event) {
    event.preventDefault(); if (blocked || customLoading || customLoadError) return;
    fieldWork.current = true; setSaving(true); setError('');
    const earlyProblems = instrumentFormErrors(draft);
    if (Object.keys(earlyProblems).length) { setFieldErrors(earlyProblems); goToProblem(earlyProblems); fieldWork.current = false; setSaving(false); return; }
    let values;
    const replay = saveRequest.current?.content === JSON.stringify(saveBody(customValues));
    try { values = replay ? customValues : await generate(customValues); }
    catch (failure) { fieldWork.current = false; setError(failure.message); setSaving(false); return; }
    const problems = instrumentFormErrors(draft);
    for (const field of customFields) {
      const problem = customFieldValidationError(field, values[field.id]); if (problem) problems[field.id] = problem;
    }
    setFieldErrors(problems); if (Object.keys(problems).length) { goToProblem(problems); fieldWork.current = false; setSaving(false); return; }
    newId.current ??= crypto.randomUUID();
    const body = saveBody(values);
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    saveRequest.current.pending = true;
    try {
      await apiRequest('/api/instruments', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      saveRequest.current.pending = false; setSaveUnknown(false); router.push(returnPath);
    } catch (failure) {
      saveRequest.current.pending = ![400, 401, 403, 404, 409, 413, 422].includes(failure.status);
      setSaveUnknown(saveRequest.current.pending); setError(failure.message); setSaving(false);
    } finally { fieldWork.current = false; }
  }
  function goToProblem(problems) {
    const keys = Object.keys(problems);
    const serviceIndex = draft.serviceConfigurations.findIndex(service => keys.some(key => key.startsWith(service.id + ':')));
    setStep(keys.some(key => Object.hasOwn(draft, key)) ? 0 : serviceIndex >= 0 ? serviceIndex + 1 : steps.length - 1);
  }
  function next() {
    if (blocked || saveUnknown) return;
    const problems = step === 0 ? Object.fromEntries(Object.entries(instrumentFormErrors(draft)).filter(([key]) => Object.hasOwn(draft, key)))
      : instrumentServiceErrors(draft.serviceConfigurations[step - 1]);
    setFieldErrors(problems);
    if (!Object.keys(problems).length) setStep(value => Math.min(steps.length - 1, value + 1));
  }
  function changeValue(key, value) {
    if (Array.isArray(value) && value.length > 500) { setFieldErrors(current => ({ ...current, [key]: 'Select at most 500 items.' })); return; }
    setDraft(current => ({ ...current, [key]: value })); clearFieldError(key);
  }
  function changeService(id, key, value) {
    if (Array.isArray(value) && value.length > 500) { setFieldErrors(current => ({ ...current, [id + ':' + key]: 'Select at most 500 items.' })); return; }
    setDraft(current => ({ ...current, serviceConfigurations: current.serviceConfigurations.map(service => service.id === id ? { ...service, [key]: value } : service) }));
    clearFieldError(id + ':' + key);
  }
  const disabled = blocked || saveUnknown;
  const service = step > 0 && step <= serviceTypes.length ? draft.serviceConfigurations[step - 1] : null;
  const storedService = instrument?.serviceConfigurations.find(item => item.id === service?.id);
  const basicControl = (key, label, placeholder, required = false, type = 'text', maximum = 200) => <FormElement type={type} label={label} mandatory={required}
    message={fieldErrors[key]} messageTone="error" inputProps={{ id: 'instrument-' + key, value: draft[key], disabled, onChange: change(key), placeholder,
      ...(type === 'date' ? { calendarOnly: true, min: '0001-01-01', max: '9999-12-31' } : { maxLength: maximum }), ...(type === 'textarea' ? { rows: 5 } : {}) }} />;
  return <div className="smplfy-new-instrument-page bg-body-tertiary d-flex flex-column"><main>
    <section className="smplfy-card card shadow mx-auto overflow-hidden w-100"><div className="d-grid h-100">
      <aside className="col-lg-3 text-bg-dark p-4"><div className="mb-3"><h1 className={instrument ? 'h6 fw-bold mb-0' : 'h4 fw-medium mb-0'}>{instrument?.name ?? 'New Instrument'}</h1></div>
        <Stepper items={steps.map((label, index) => ({ label, state: index === step ? 'active' : index < step || instrument ? 'completed' : 'default' }))}
          onItemClick={instrument && !disabled ? setStep : undefined} />
      </aside>
      <form className="col d-flex flex-column overflow-hidden" onSubmit={event => { if (step === steps.length - 1) void save(event); else { event.preventDefault(); next(); } }} noValidate>
        <div className="flex-fill overflow-auto">
          {error ? <div className="alert alert-danger m-4" role="alert">{error}</div> : null}
          {saveUnknown ? <p className="alert alert-warning mx-4" role="status">The save response was interrupted. Retry Save with the same details to confirm the result.</p> : null}
          {step === 0 ? <div className="container-fluid p-4 p-lg-5"><div className="row g-4">
            <div className="col-12">{basicControl('name', 'Name', 'eg. Carpet Static Loading Machine', true)}</div>
            <div className="col-lg-6"><InstrumentChoice kind="laboratories" id="instrument-laboratoryId" label="Lab" required value={draft.laboratoryId}
              retained={instrument?.laboratoryId ? [{ id: instrument.laboratoryId, name: instrument.laboratoryName }] : emptyFields} disabled={disabled} error={fieldErrors.laboratoryId}
              placeholder="Select lab" onChange={value => changeValue('laboratoryId', value)} /></div>
            <div className="col-lg-6">{basicControl('code', 'Unique Key', 'eg. CSL-01', true, 'text', 64)}</div>
            <div className="col-lg-6">{basicControl('serialNumber', 'Serial Number', 'eg. 37653')}</div>
            <div className="col-lg-6">{basicControl('make', 'Make', 'eg. SDL-UK')}</div>
            <div className="col-lg-6">{basicControl('modelName', 'Model', 'eg. K 043')}</div>
            <div className="col-lg-6">{basicControl('dateOfInstallation', 'Date of installation', 'dd/mm/yyyy', true, 'date')}</div>
            <div className="col-12"><InstrumentChoice kind="users" id="instrument-allowedUserIds" label="Allow Access to" required multiple value={draft.allowedUserIds}
              retained={instrument?.allowedUsers} disabled={disabled} error={fieldErrors.allowedUserIds} placeholder="Select user(s)" onChange={value => changeValue('allowedUserIds', value)} /></div>
            <div className="col-12">{basicControl('description', 'Description', 'eg. Technical Manager', false, 'textarea', 5000)}</div>
          </div></div> : null}
          {service ? <div className="container-fluid p-4 p-lg-5"><div className="row g-4">
            {!isBreakdownService(service.serviceCode) ? [['lastPerformedOn', 'Last Performed On', 'date'], ['frequencyDays', 'Frequency(in days)', 'number'],
              ['reminderBeforeDays', 'Remind Before days', 'number'], ['reminderFrequencyDays', 'Reminder Frequency', 'number']].map(([key, label, type]) =>
              <div className="col-lg-6" key={key}><FormElement type={type === 'date' ? 'date' : 'text'} label={label} message={fieldErrors[service.id + ':' + key]} messageTone="error"
                inputProps={{ id: 'instrument-service-' + key, value: service[key], disabled, onChange: event => changeService(service.id, key, event.target.value),
                  ...(type === 'date' ? { calendarOnly: true, min: '0001-01-01', max: '9999-12-31' } : { type, step: 1, min: key === 'reminderBeforeDays' ? 0 : 1, max: key === 'frequencyDays' ? 36500 : 3650 }) }} /></div>) : null}
            <div className="col-12"><InstrumentChoice key={service.id + ':roles'} kind="roles" id="instrument-service-reminderRoleIds" label="Remind To" multiple value={service.reminderRoleIds}
              retained={storedService?.reminderRoles} disabled={disabled} error={fieldErrors[service.id + ':reminderRoleIds']} placeholder="Nothing selected"
              onChange={value => changeService(service.id, 'reminderRoleIds', value)} /></div>
            {[['templates', 'templateId', 'Template', 'templateName'], ['workflows', 'workflowId', 'Workflow', 'workflowName']].map(([kind, key, label, name]) =>
              <div className="col-lg-6" key={service.id + key}><InstrumentChoice kind={kind} id={'instrument-service-' + key} label={label} value={service[key]}
                retained={storedService?.[key] ? [{ id: storedService[key], name: storedService[name] }] : emptyFields}
                disabled={disabled} error={fieldErrors[service.id + ':' + key]} placeholder={'Select ' + label} onChange={value => changeService(service.id, key, value)} /></div>)}
          </div></div> : null}
          {step === steps.length - 1 ? <div className="container-fluid p-4 p-lg-5"><MasterCustomFields kind="instrument" showTitle={false} fields={customFields} loading={customLoading}
            loadError={customLoadError} values={customValues} storedFields={storedFields} lookupSources={lookupSources} errors={fieldErrors} disabled={disabled}
            generatingId={generatingId} onChange={changeCustomField} onBusy={onUploadBusy} onGenerate={generateField} onReload={reloadFields} /></div> : null}
        </div>
        <div className="d-flex align-items-center justify-content-between gap-3 p-4 border-top bg-white flex-wrap flex-shrink-0">
          <SecondaryButton leftIcon="chevron-left" disabled={disabled} onClick={() => step > 0 ? setStep(value => value - 1) : router.push(returnPath)}>{step > 0 ? steps[step - 1] : 'Cancel'}</SecondaryButton>
          {step === steps.length - 1 ? <PrimaryButton type="submit" leftIcon="save" disabled={blocked || customLoading || Boolean(customLoadError)}>{saving ? 'Saving...' : instrument ? 'Save Changes' : 'Save Instrument'}</PrimaryButton>
            : <PrimaryButton type="submit" rightIcon="chevron-right" disabled={disabled}>Next</PrimaryButton>}
        </div>
      </form>
    </div></section>
  </main></div>;
}
