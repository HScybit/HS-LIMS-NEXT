'use client';

import { useRef, useState } from 'react';
import FormElement from '../ui/FormElement.jsx';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import MaterialChoice from './MaterialChoice.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function MaterialFormModal({ material, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({ name: material?.name ?? '', code: material?.code ?? '', description: material?.description ?? '',
    categoryId: material?.categoryId ?? '', measurementUnitId: material?.measurementUnitId ?? '', initialQuantity: material?.initialQuantity ?? '', minimumQuantity: material?.minimumQuantity ?? '' }));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [errors, setErrors] = useState({});
  const id = useRef(null); const request = useRef(null);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setErrors(current => ({ ...current, [key]: '' })); };
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const next = {};
    for (const [key, label] of [['name', 'Name'], ['code', 'Unique key'], ['categoryId', 'Category'], ['measurementUnitId', 'Unit'], ['initialQuantity', 'Initial quantity'], ['minimumQuantity', 'Min. quantity']]) {
      if (!String(draft[key]).trim()) next[key] = `${label} is required.`;
      else if (['initialQuantity', 'minimumQuantity'].includes(key) && (!Number.isFinite(Number(draft[key])) || Number(draft[key]) < 0)) next[key] = 'Enter zero or a positive value.';
    }
    setErrors(next); if (Object.keys(next).length) return;
    id.current ??= crypto.randomUUID(); const body = { ...draft, id: material?.id ?? id.current, revision: material?.revision ?? 0 };
    const content = JSON.stringify(body); if (request.current?.content !== content) request.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try { const result = await apiRequest('/api/materials', { method: 'POST', body: { ...body, requestId: request.current.id } }); onSaved(result); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <Modal open title={material ? 'Edit Material' : 'New Material'} titleIcon="materials" onClose={() => { if (!saving) onClose(); }} actions={<>
    <SecondaryButton leftIcon="close" disabled={saving} onClick={onClose}>Cancel</SecondaryButton><PrimaryButton form="materials-form" type="submit" leftIcon="save" disabled={saving}>{saving ? 'Saving...' : 'Save'}</PrimaryButton>
  </>}><form id="materials-form" onSubmit={save} className="d-flex flex-column gap-4" noValidate>
    {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
    <FormElement label="Name" mandatory message={errors.name} messageTone="error" inputProps={{ value: draft.name, maxLength: 200, disabled: saving, placeholder: 'eg.', onChange: event => change('name', event.target.value) }} />
    <div className="row g-3"><div className="col-12 col-md-6"><FormElement label="Unique Key" mandatory message={errors.code} messageTone="error" inputProps={{ value: draft.code, maxLength: 64, disabled: saving, placeholder: 'eg.', onChange: event => change('code', event.target.value) }} /></div>
      <div className="col-12 col-md-6"><MaterialChoice kind="category" label="Category" value={draft.categoryId} selected={material ? { id: material.categoryId, label: material.categoryName } : null} message={errors.categoryId} disabled={saving} onChange={value => change('categoryId', value)} /></div>
      <div className="col-12 col-md-6"><MaterialChoice kind="unit" label="Unit (UoM)" value={draft.measurementUnitId} selected={material ? { id: material.measurementUnitId, label: material.unitName } : null} message={errors.measurementUnitId} disabled={saving} onChange={value => change('measurementUnitId', value)} /></div>
      {[['minimumQuantity', 'Min. Quantity'], ['initialQuantity', 'Initial Quantity']].map(([key, label]) => <div key={key} className="col-12 col-md-6"><FormElement label={label} mandatory message={errors[key]} messageTone="error" inputProps={{ value: draft[key], type: 'number', min: '0', step: 'any', inputMode: 'decimal', placeholder: 'eg.', disabled: saving, onChange: event => change(key, event.target.value) }} /></div>)}
    </div>
    <FormElement type="textarea" label="Description" inputProps={{ value: draft.description, rows: 3, maxLength: 16000, disabled: saving, placeholder: 'eg.', onChange: event => change('description', event.target.value) }} />
  </form></Modal>;
}
