'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';
import MasterCustomFields from './MasterCustomFields.jsx';
import { customFieldSubmittedValue, customFieldValidationError, customFieldNeedsGeneration } from '../../custom-fields/form-values.js';
import { masterCustomFieldDraft } from '../../masters/custom-field-draft.js';
import { loadMasterFieldLookupSources } from '../../masters/custom-field-lookup-client.js';

const emptyFields = [];

const userOption = (user) => ({ value: user.id, label: String(user.name ?? user.id).replace(/[_/-]/g, ' ').replace(/\s+/g, ' ').trim() });

export default function MethodForm({ method }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: method?.name ?? '', uuid: method?.uuid ?? '', description: method?.description ?? '',
    decimalScale: method?.decimalScale ?? 4, parseNumber: String(method?.parseNumber ?? false), accessUserIds: method?.accessUserIds ?? [] }));
  const [userOptions, setUserOptions] = useState(() => method?.accessUsers.map(userOption) ?? []);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const [userError, setUserError] = useState(''); const [moreUsers, setMoreUsers] = useState(false); const userQuery = useRef(null);
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
  const storedFields = method?.customFields ?? emptyFields;

  const from = search.get('from'); const returnPath = from && /^\/method_of_analysis(?:\?[^#]*)?$/.test(from) ? from : '/method_of_analysis';
  useEffect(() => () => userQuery.current?.abort(), []);
  useEffect(() => {
    if (!canRefreshFields) return undefined;
    const controller = new AbortController(); fieldLoad.current = controller;
    const canPublish = () => !controller.signal.aborted && !fieldWork.current && !saveRequest.current?.pending && !uploadBusy.current.size;
    apiRequest('/api/masters/methods/custom-fields', { signal: controller.signal }).then(async ({ fields, organizationId }) => {
      const sources = await loadMasterFieldLookupSources('method', fields, lookupCache.current, { signal: controller.signal, organizationId });
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
  const loadUsers = useCallback(async (search) => {
    userQuery.current?.abort(); const controller = new AbortController(); userQuery.current = controller;
    try {
      const result = await apiRequest(`/api/masters/methods/users?search=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (controller.signal.aborted) return [];
      setUserError(''); setMoreUsers(result.hasMore);
      return result.rows.map(userOption);
    } catch (failure) {
      if (!controller.signal.aborted) { setUserError(failure.message); setMoreUsers(false); }
      return [];
    }
  }, []);
  function clearFieldError(field) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const { [field]: _error, ...rest } = current; return rest;
    });
  }
  const change = (field) => (event) => {
    const value = event.target.value; setDraft((current) => ({ ...current, [field]: value })); clearFieldError(field);
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
    if (!fieldId && !customFields.some((field) => customFieldNeedsGeneration(field, method ? 'edit' : 'create', values[field.id]))) return values;
    const result = await apiRequest('/api/masters/methods/custom-field-generation', { method: 'POST', body: {
      methodId: method?.id ?? null, method: draft, ...capture(values), fieldId: fieldId ?? null,
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
    return { ...draft, ...capture(values), id: method?.id ?? newId.current, revision: method?.revision ?? 0,
      name: draft.name.trim(), uuid: draft.uuid.trim(), decimalScale: draft.decimalScale === '' ? 4 : Number(draft.decimalScale), parseNumber: draft.parseNumber === 'true' };
  }
  async function save(event) {
    event.preventDefault(); if (blocked || customLoading || customLoadError) return;
    fieldWork.current = true; setSaving(true); setError('');
    let values;
    const replay = saveRequest.current?.content === JSON.stringify(saveBody(customValues));
    try { values = replay ? customValues : await generate(customValues); }
    catch (failure) { fieldWork.current = false; setError(failure.message); setSaving(false); return; }
    const problems = {};
    for (const [field, label] of [['name', 'Name'], ['uuid', 'UUID']]) if (!draft[field].trim()) problems[field] = `${label} is required.`;
    const decimalScale = draft.decimalScale === '' ? 4 : Number(draft.decimalScale);
    if (!Number.isInteger(decimalScale) || decimalScale < 0 || decimalScale > 12) problems.decimalScale = 'Decimal Places must be an integer between 0 and 12.';
    if (draft.accessUserIds.length > 500) problems.accessUserIds = 'Select at most 500 users.';
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
      await apiRequest('/api/masters/methods', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      saveRequest.current.pending = false; setSaveUnknown(false); router.push(returnPath);
    } catch (failure) {
      saveRequest.current.pending = ![400, 401, 403, 404, 409, 413, 422].includes(failure.status);
      setSaveUnknown(saveRequest.current.pending); setError(failure.message); setSaving(false);
    } finally { fieldWork.current = false; }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="mb-3"><FormElement label="Name" mandatory helperText="Name of the Method" message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Method Name', value: draft.name, onChange: change('name'), maxLength: 200, disabled: blocked }} /></div>
      <div className="mb-3"><FormElement label="UUID" mandatory helperText="UUID of the Method" message={fieldErrors.uuid} messageTone="error"
        inputProps={{ name: 'uuid', placeholder: 'Method Name', value: draft.uuid, onChange: change('uuid'), maxLength: 100, disabled: blocked }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Add Description', value: draft.description, onChange: change('description'), rows: 3, maxLength: 16000, disabled: blocked }} /></div>
      <div className="mb-3"><FormElement label="Decimal Places" helperText="The no of digits after decimal(defaults to 4)" message={fieldErrors.decimalScale} messageTone="error"
        inputProps={{ type: 'number', name: 'decimalScale', placeholder: 'No of Digits after Decimal', min: 0, max: 12, step: 1, value: draft.decimalScale, onChange: change('decimalScale'), disabled: blocked }} /></div>
      <div className="mb-3"><FormElement type="dropdown" label="Convert Number"
        helperText="If the expected output is a number, marking this as YES will convert the number in the required decimal denomination"
        inputProps={{ name: 'parseNumber', placeholder: 'Select Convert Number', value: draft.parseNumber, onChange: change('parseNumber'),
          options: [{ value: 'false', label: 'NO' }, { value: 'true', label: 'YES' }], disabled: blocked }} /></div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row">
        <label className="smplfy-form-element__label" htmlFor="method-users">Allow access to</label></div>
        <SearchableSelect id="method-users" name="accessUserIds" placeholder="Select users" multiple clearable value={draft.accessUserIds} options={userOptions}
          loadOptions={loadUsers} cacheOptions={false} disabled={blocked} invalid={Boolean(fieldErrors.accessUserIds || userError)}
          aria-describedby={fieldErrors.accessUserIds || userError ? 'method-users-error' : moreUsers ? 'method-users-more' : undefined}
          noOptionsMessage={userError ? 'Users could not be loaded. Try searching again.' : 'No options found'}
          onChange={(values, options) => { setDraft((current) => ({ ...current, accessUserIds: values })); setUserOptions(options); clearFieldError('accessUserIds'); }} />
        {moreUsers ? <div id="method-users-more" className="smplfy-form-text form-text">More users match. Refine your search to find a user.</div> : null}
        {fieldErrors.accessUserIds || userError ? <div id="method-users-error" className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.accessUserIds || userError}</div> : null}
      </div>
      <MasterCustomFields kind="method" fields={customFields} loading={customLoading} loadError={customLoadError} values={customValues} storedFields={storedFields} lookupSources={lookupSources}
        errors={fieldErrors} disabled={blocked} generatingId={generatingId} onChange={changeCustomField} onBusy={onUploadBusy} onGenerate={generateField}
        onReload={reloadFields} />
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={blocked} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={blocked || customLoading || Boolean(customLoadError)}>{saving ? 'Saving...' : method ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
