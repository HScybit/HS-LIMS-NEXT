'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import UserReferenceField from '../users/UserReferenceField.jsx';
import { apiRequest } from '../../lib/api-client.js';

const ranges = [['minimumTemperature', 'Min Temperature'], ['maximumTemperature', 'Max Temperature'], ['minimumHumidity', 'Min Humidity'], ['maximumHumidity', 'Max Humidity']];
const optionalText = ['abbreviation', 'description', ...ranges.map(([key]) => key)];
export default function LaboratoryForm({ laboratory }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null); const pending = useRef(false);
  const [draft, setDraft] = useState(() => ({ code: laboratory?.code ?? '', name: laboratory?.name ?? '', active: laboratory?.active ?? true,
    ...Object.fromEntries(optionalText.map(key => [key, laboratory?.[key] ?? ''])), businessUnitId: laboratory?.businessUnitId ?? null,
    headUserId: laboratory?.headUserId ?? null, delegateUserId: laboratory?.delegateUserId ?? null }));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [invalid, setInvalid] = useState({});
  const from = search.get('from'); const returnPath = from && /^\/lab_management(?:\?[^#]*)?$/.test(from) ? from : '/lab_management';
  function change(key, value) { setDraft(current => ({ ...current, [key]: value })); setInvalid(current => ({ ...current, [key]: '' })); }
  async function save(event) {
    event.preventDefault(); if (pending.current) return;
    const errors = {};
    for (const key of ['name', 'code']) if (!draft[key].trim()) errors[key] = 'Required';
    if (draft.name !== laboratory?.name && draft.name.trim().length > 200) errors.name = 'Enter up to 200 characters.';
    if (!errors.code && draft.code !== laboratory?.code && (draft.code.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(draft.code))) errors.code = 'Use letters, numbers, dots, underscores, slashes or hyphens; start with a letter or number.';
    for (const [key, maximum] of [['abbreviation', 20], ['description', 2000], ...ranges.map(([key]) => [key, 2000])]) {
      if (draft[key] !== (laboratory?.[key] ?? '') && draft[key].length > maximum) errors[key] = `Enter up to ${maximum} characters.`;
    }
    for (const [key] of ranges) if ((!laboratory || draft[key] !== (laboratory[key] ?? '')) && draft[key] === '') errors[key] = 'Required';
    if (Object.keys(errors).length) { setInvalid(errors); return; }
    newId.current ??= crypto.randomUUID();
    const body = { ...draft, ...Object.fromEntries(optionalText.map(key => [key, draft[key] === '' && laboratory?.[key] == null ? null : draft[key]])),
      id: laboratory?.id ?? newId.current, revision: laboratory?.revision ?? 0 };
    const content = JSON.stringify(body); if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    pending.current = true; setSaving(true); setError('');
    try { await apiRequest('/api/administration/laboratories', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } }); router.push(returnPath); }
    catch (failure) { setError(failure.message); pending.current = false; setSaving(false); }
  }
  function textField(key, label, maximum, required = false) {
    return <div className="mb-3" key={key}><FormElement label={label} mandatory={required} message={invalid[key]} messageTone="error"
      inputProps={{ name: key, value: draft[key], maxLength: Math.max(maximum, laboratory?.[key]?.length ?? 0), disabled: saving, onChange: event => change(key, event.target.value) }} /></div>;
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      {textField('name', 'Name', 200, true)}{textField('abbreviation', 'Abbreviation', 20)}
      <UserReferenceField kind="managers" name="headUserId" label="Head of Lab" placeholder="Select HoD" includeInactive value={draft.headUserId} savedLabel={laboratory?.headUserName}
        disabled={saving} onChange={value => change('headUserId', value || null)} />
      <UserReferenceField kind="managers" name="delegateUserId" label="Delegate Authority to" placeholder="Select Delegate Authority" includeInactive value={draft.delegateUserId} savedLabel={laboratory?.delegateUserName}
        disabled={saving} onChange={value => change('delegateUserId', value || null)} />
      {ranges.map(([key, label]) => textField(key, label, 2000, !laboratory || Boolean(laboratory[key]) || draft[key] !== ''))}
      {textField('code', 'Code', 64, true)}
      <UserReferenceField kind="businessUnits" name="businessUnitId" label="Business unit" placeholder="Select Business unit" value={draft.businessUnitId} savedLabel={laboratory?.businessUnitName}
        disabled={saving} onChange={value => change('businessUnitId', value || null)} />
      {textField('description', 'Description', 2000)}
      <div className="mb-3 smplfy-checkbox-field"><Checkbox id="lab-active" checked={draft.active} ariaLabel="Active" disabled={saving} onChange={value => change('active', value)} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="lab-active">Active</label></div></div>
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving}>{saving ? 'Saving...' : laboratory ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
