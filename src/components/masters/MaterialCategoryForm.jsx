'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage, { FormSection, FormField } from '../ui/FormPage.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function MaterialCategoryForm({ category }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: category?.name ?? '', description: category?.description ?? '', reusable: category?.reusable ?? false, expirable: category?.expirable ?? false }));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [nameError, setNameError] = useState('');
  const from = search.get('from'); const returnPath = from && /^\/material_categories(?:\?[^#]*)?$/.test(from) ? from : '/material_categories';
  async function save(event) {
    event.preventDefault(); if (saving) return;
    if (!draft.name.trim()) { setNameError('Name is required.'); return; }
    newId.current ??= crypto.randomUUID();
    const body = { ...draft, id: category?.id ?? newId.current, revision: category?.revision ?? 0, name: draft.name.trim(), description: draft.description.trim() };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/masters/material-categories', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <FormPage title={category ? 'Edit Material Category' : 'New Material Category'} backTo={returnPath} backLabel="Back to material categories"
    formId="material-category-form" onSubmit={save} saving={saving} submitLabel={category ? 'Update' : 'Create'} error={error}
    actions={<SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>}>
    <FormSection title="Category Details" last>
      <FormField span={12}><FormElement label="Name" mandatory message={nameError} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Enter material category name', value: draft.name, maxLength: 200, disabled: saving,
          onChange: event => { setDraft(current => ({ ...current, name: event.target.value })); setNameError(''); } }} /></FormField>
      <FormField span={12}><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Enter description', value: draft.description, rows: 3, maxLength: 16000, disabled: saving,
          onChange: event => setDraft(current => ({ ...current, description: event.target.value })) }} /></FormField>
      {[['reusable', 'Reusable'], ['expirable', 'Expirable']].map(([key, label]) => <FormField key={key}>
        <div className="smplfy-checkbox-field"><Checkbox id={`category-${key}`} checked={draft[key]} ariaLabel={label} disabled={saving}
          onChange={checked => setDraft(current => ({ ...current, [key]: checked }))} />
          <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={`category-${key}`}>{label}</label></div>
        </div>
      </FormField>)}
    </FormSection>
  </FormPage>;
}
