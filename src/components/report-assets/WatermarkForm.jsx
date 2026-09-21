'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage, { FormSection, FormField } from '../ui/FormPage.jsx';
import { apiRequest } from '../../lib/api-client.js';
import WatermarkImageField from './WatermarkImageField.jsx';

export default function WatermarkForm({ watermark }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: watermark?.name ?? '', opacity: watermark?.opacity ?? 0.5,
    height: watermark?.height ?? '', width: watermark?.width ?? '', rotation: watermark?.rotation ?? 0 }));
  const [image, setImage] = useState(() => watermark ? { id: watermark.imageId, name: watermark.imageName, url: watermark.imageUrl } : null);
  const [uploadBlocked, setUploadBlocked] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const from = search.get('from'); const returnPath = from && /^\/watermark_report(?:\?[^#]*)?$/.test(from) ? from : '/watermark_report';
  function clearFieldError(field) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const { [field]: _error, ...rest } = current; return rest;
    });
  }
  const change = (field) => (event) => {
    const value = event.target.value; setDraft((current) => ({ ...current, [field]: value })); clearFieldError(field);
  };
  function changeImage(value) { setImage(value); clearFieldError('image'); }

  async function save(event) {
    event.preventDefault(); if (saving || uploadBlocked) return;
    const problems = {};
    if (!draft.name.trim()) problems.name = 'Name is required.';
    if (!image) problems.image = 'Upload Image is required.';
    for (const field of ['height', 'width']) {
      const value = Number(draft[field]);
      if (draft[field] === '' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) problems[field] = `${field === 'height' ? 'Height' : 'Width'} must be an integer between 1 and 10000.`;
    }
    setFieldErrors(problems); if (Object.keys(problems).length) return;
    newId.current ??= crypto.randomUUID();
    const body = { watermarkId: watermark?.id ?? newId.current, revision: watermark?.revision ?? 0, name: draft.name.trim(), imageId: image.id,
      opacity: Number(draft.opacity), width: Number(draft.width), height: Number(draft.height), rotation: Number(draft.rotation) };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/report-assets/watermarks', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <FormPage title={watermark ? 'Edit Watermark' : 'New Watermark'} backTo={returnPath} backLabel="Back to watermarks"
    formId="watermark-form" onSubmit={save} saving={saving} disabled={saving || uploadBlocked}
    submitLabel={watermark ? 'Update' : 'Create'} error={error}
    actions={<SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>}>
    <FormSection title="Watermark Details">
      <FormField span={12}><FormElement label="Name" mandatory message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', value: draft.name, onChange: change('name'), maxLength: 200, disabled: saving }} /></FormField>
      <FormField span={12}><WatermarkImageField image={image} disabled={saving} error={fieldErrors.image} onChange={changeImage} onUploadBlocked={setUploadBlocked} /></FormField>
      {image ? <FormField span={12}>
        <div style={{ width: '100%', height: 320, border: '1px solid #dee2e6', borderRadius: 8, background: '#f8f9fa', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
          {/* The source preview uses original image bytes without image optimization. */}
          <img src={image.url} alt="preview" style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transition: 'all 0.25s ease',
            opacity: Number(draft.opacity), transform: `rotate(${Number(draft.rotation)}deg)`, width: Number(draft.width) > 0 ? Number(draft.width) : undefined, height: Number(draft.height) > 0 ? Number(draft.height) : undefined }} />
        </div>
      </FormField> : null}
    </FormSection>

    <FormSection title="Appearance" last>
      <FormField><FormElement label="Height (px)" mandatory message={fieldErrors.height} messageTone="error"
        inputProps={{ type: 'number', name: 'height', min: 1, max: 10_000, step: 1, value: draft.height, onChange: change('height'), disabled: saving }} /></FormField>
      <FormField><FormElement label="Width (px)" mandatory message={fieldErrors.width} messageTone="error"
        inputProps={{ type: 'number', name: 'width', min: 1, max: 10_000, step: 1, value: draft.width, onChange: change('width'), disabled: saving }} /></FormField>
      <FormField><div style={{ maxWidth: '50%' }}><FormElement type="range" label="Opacity (0 to 1)" mandatory
        inputProps={{ name: 'opacity', min: 0, max: 1, step: 0.1, value: draft.opacity, onChange: change('opacity'), disabled: saving }} /></div></FormField>
      <FormField><div style={{ maxWidth: '50%', minWidth: 'calc(60px + var(--smplfy-field-action-width) + 2 * var(--smplfy-field-border-width))' }}><FormElement type="step-increment" label="Rotate Image"
        inputProps={{ name: 'rotation', value: draft.rotation, onChange: change('rotation'), disabled: saving }} /></div></FormField>
    </FormSection>
  </FormPage>;
}
