'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { checklistInput } from '../../checklists/input.js';

export default function ChecklistForm({ checklist }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const firstItemId = useRef(null); const saveRequest = useRef(null);
  const [name, setName] = useState(checklist?.name ?? ''); const [isActive, setIsActive] = useState(checklist?.isActive ?? false);
  const [items, setItems] = useState(() => checklist ? checklist.items.map(({ id, prompt }) => ({ id, prompt })) : [{ id: 'new-item', prompt: '' }]);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [nameError, setNameError] = useState('');
  const from = search.get('from'); const returnPath = from && /^\/checklists(?:\?[^#]*)?$/.test(from) ? from : '/checklists';
  function removeItem(id) {
    setItems((current) => current.length === 1 ? [{ ...current[0], prompt: '' }] : current.filter((item) => item.id !== id));
  }
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const nameChanged = !checklist || name !== checklist.name;
    if (nameChanged && !name.trim()) { setNameError('Name is required.'); return; }
    setSaving(true); setError(''); newId.current ??= crypto.randomUUID(); firstItemId.current ??= crypto.randomUUID();
    const itemsChanged = !checklist || JSON.stringify(items) !== JSON.stringify(checklist.items.map(({ id, prompt }) => ({ id, prompt })));
    const body = { revision: checklist?.revision ?? 0, ...(!checklist ? { id: newId.current } : {}),
      ...(nameChanged ? { name } : {}), ...(!checklist || isActive !== checklist.isActive ? { isActive } : {}),
      ...(itemsChanged ? { items: items.map((item) => ({ id: item.id === 'new-item' ? firstItemId.current : item.id, prompt: item.prompt })) } : {}) };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    try {
      const normalized = checklistInput({ ...body, id: checklist?.id ?? newId.current, requestId: saveRequest.current.id }, { create: !checklist });
      if (checklist) delete normalized.id;
      await apiRequest(checklist ? `/api/checklists/${checklist.id}` : '/api/checklists', { method: checklist ? 'PATCH' : 'POST', body: normalized });
      router.push(returnPath); router.refresh();
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="mb-3"><FormElement label="Name" mandatory message={nameError} messageTone="error"
        inputProps={{ name: 'name', value: name, placeholder: 'Checklist Name', maxLength: 200, disabled: saving, onChange: (event) => { setName(event.target.value); setNameError(''); } }} /></div>
      <div className="mb-3"><div className="d-flex align-items-center justify-content-between mb-2">
        <label className="smplfy-form-label form-label mb-0">Line Items</label>
        <button type="button" className="btn btn-sm btn-primary" aria-label="Add line item" disabled={saving || items.length >= 200}
          onClick={() => setItems((current) => [...current, { id: crypto.randomUUID(), prompt: '' }])}>+</button>
      </div>
        {items.map((item, index) => <div key={item.id} className="d-flex align-items-center gap-2 mb-2"><div className="flex-grow-1">
          <FormElement inputProps={{ value: item.prompt, placeholder: 'Enter item...', 'aria-label': `Line item ${index + 1}`, maxLength: 500, disabled: saving,
            onChange: (event) => { const prompt = event.target.value; setItems((current) => current.map((value) => value.id === item.id ? { ...value, prompt } : value)); } }} />
        </div><button type="button" className="btn btn-sm btn-danger" aria-label={`Remove line item ${index + 1}`} disabled={saving} onClick={() => removeItem(item.id)}><AppIcon name="trash" size={13} /></button></div>)}
      </div>
      <div className="mb-3"><div className="smplfy-checkbox-field">
        <Checkbox id="checklist-is-active" ariaLabel="Is Active?" checked={isActive} disabled={saving} onChange={setIsActive} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="checklist-is-active">Is Active?</label></div>
      </div></div>
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving}>{saving ? 'Saving...' : checklist ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
