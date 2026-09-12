'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';

const userOption = (user) => ({ value: user.id, label: String(user.name ?? user.id).replace(/[_/-]/g, ' ').replace(/\s+/g, ' ').trim() });

export default function MethodForm({ method }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: method?.name ?? '', uuid: method?.uuid ?? '', description: method?.description ?? '',
    decimalScale: method?.decimalScale ?? 4, parseNumber: String(method?.parseNumber ?? false), accessUserIds: method?.accessUserIds ?? [] }));
  const [userOptions, setUserOptions] = useState(() => method?.accessUsers.map(userOption) ?? []);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const [userError, setUserError] = useState(''); const [moreUsers, setMoreUsers] = useState(false); const userQuery = useRef(null);
  const from = search.get('from'); const returnPath = from && /^\/method_of_analysis(?:\?[^#]*)?$/.test(from) ? from : '/method_of_analysis';
  useEffect(() => () => userQuery.current?.abort(), []);
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
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const problems = {};
    for (const [field, label] of [['name', 'Name'], ['uuid', 'UUID']]) if (!draft[field].trim()) problems[field] = `${label} is required.`;
    const decimalScale = draft.decimalScale === '' ? 4 : Number(draft.decimalScale);
    if (!Number.isInteger(decimalScale) || decimalScale < 0 || decimalScale > 12) problems.decimalScale = 'Decimal Places must be an integer between 0 and 12.';
    if (draft.accessUserIds.length > 500) problems.accessUserIds = 'Select at most 500 users.';
    setFieldErrors(problems); if (Object.keys(problems).length) return;
    newId.current ??= crypto.randomUUID();
    const body = { ...draft, id: method?.id ?? newId.current, revision: method?.revision ?? 0,
      name: draft.name.trim(), uuid: draft.uuid.trim(), decimalScale, parseNumber: draft.parseNumber === 'true' };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/masters/methods', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="mb-3"><FormElement label="Name" mandatory helperText="Name of the Method" message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Method Name', value: draft.name, onChange: change('name'), maxLength: 200, disabled: saving }} /></div>
      <div className="mb-3"><FormElement label="UUID" mandatory helperText="UUID of the Method" message={fieldErrors.uuid} messageTone="error"
        inputProps={{ name: 'uuid', placeholder: 'Method Name', value: draft.uuid, onChange: change('uuid'), maxLength: 100, disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Add Description', value: draft.description, onChange: change('description'), rows: 3, maxLength: 16000, disabled: saving }} /></div>
      <div className="mb-3"><FormElement label="Decimal Places" helperText="The no of digits after decimal(defaults to 4)" message={fieldErrors.decimalScale} messageTone="error"
        inputProps={{ type: 'number', name: 'decimalScale', placeholder: 'No of Digits after Decimal', min: 0, max: 12, step: 1, value: draft.decimalScale, onChange: change('decimalScale'), disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="dropdown" label="Convert Number"
        helperText="If the expected output is a number, marking this as YES will convert the number in the required decimal denomination"
        inputProps={{ name: 'parseNumber', placeholder: 'Select Convert Number', value: draft.parseNumber, onChange: change('parseNumber'),
          options: [{ value: 'false', label: 'NO' }, { value: 'true', label: 'YES' }], disabled: saving }} /></div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row">
        <label className="smplfy-form-element__label" htmlFor="method-users">Allow access to</label></div>
        <SearchableSelect id="method-users" name="accessUserIds" placeholder="Select users" multiple clearable value={draft.accessUserIds} options={userOptions}
          loadOptions={loadUsers} cacheOptions={false} disabled={saving} invalid={Boolean(fieldErrors.accessUserIds || userError)}
          aria-describedby={fieldErrors.accessUserIds || userError ? 'method-users-error' : moreUsers ? 'method-users-more' : undefined}
          noOptionsMessage={userError ? 'Users could not be loaded. Try searching again.' : 'No options found'}
          onChange={(values, options) => { setDraft((current) => ({ ...current, accessUserIds: values })); setUserOptions(options); clearFieldError('accessUserIds'); }} />
        {moreUsers ? <div id="method-users-more" className="smplfy-form-text form-text">More users match. Refine your search to find a user.</div> : null}
        {fieldErrors.accessUserIds || userError ? <div id="method-users-error" className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.accessUserIds || userError}</div> : null}
      </div>
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving}>{saving ? 'Saving...' : method ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
