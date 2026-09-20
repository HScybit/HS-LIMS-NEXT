'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function BusinessUnitForm({ unit }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null); const pending = useRef(false);
  const [draft, setDraft] = useState(() => ({ code: unit?.code ?? '', name: unit?.name ?? '', description: unit?.description ?? '', active: unit?.active ?? true }));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [invalid, setInvalid] = useState({});
  const from = search.get('from'); const returnPath = from && /^\/unit_management(?:\?[^#]*)?$/.test(from) ? from : '/unit_management';
  async function save(event) {
    event.preventDefault(); if (pending.current) return;
    const errors = Object.fromEntries(['name', 'description', 'code'].filter(key => !draft[key].trim()).map(key => [key, 'Required']));
    if (Object.keys(errors).length) { setInvalid(errors); return; }
    newId.current ??= crypto.randomUUID();
    const body = { ...draft, id: unit?.id ?? newId.current, revision: unit?.revision ?? 0, code: draft.code.trim(), name: draft.name.trim(), description: draft.description.trim() };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    pending.current = true; setSaving(true); setError('');
    try {
      await apiRequest('/api/administration/business-units', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); pending.current = false; setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      {[['name', 'Name', 200], ['description', 'Description', 2000], ['code', 'Code', 64]].map(([key, label, maxLength]) => <div className="mb-3" key={key}>
        <FormElement label={label} mandatory message={invalid[key]} messageTone="error" inputProps={{ name: key, value: draft[key], maxLength, disabled: saving,
          onChange: event => { setDraft(current => ({ ...current, [key]: event.target.value })); setInvalid(current => ({ ...current, [key]: '' })); } }} />
      </div>)}
      <div className="mb-3 smplfy-checkbox-field"><Checkbox id="unit-active" checked={draft.active} ariaLabel="Active" disabled={saving}
        onChange={checked => setDraft(current => ({ ...current, active: checked }))} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="unit-active">Active</label></div>
      </div>
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving}>{saving ? 'Saving...' : unit ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
