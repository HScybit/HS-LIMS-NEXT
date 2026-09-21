'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage, { FormSection, FormField } from '../ui/FormPage.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function TemplateCreate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const templateType = form.get('templateType');
      await apiRequest('/api/templates', { method: 'POST', body: { name: form.get('name'), description: form.get('description'), code: form.get('code'), templateType, kind: templateType === 'sample_coa' ? 'report' : 'datasheet' } });
      showToast('Saved successfully!', 'success'); router.push('/master_template_management');
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <FormPage title="New Template" backTo="/master_template_management" backLabel="Back to templates"
    formId="template-create-form" onSubmit={submit} saving={busy} submitLabel="Save"
    error={error}
    actions={<SecondaryButton type="button" disabled={busy} onClick={() => router.push('/master_template_management')}>Cancel</SecondaryButton>}>
    <FormSection title="Template Details" last>
      <FormField><FormElement label="Name" mandatory inputProps={{ name: 'name', placeholder: 'Enter name', maxLength: 200 }} /></FormField>
      <FormField><FormElement label="UUID" inputProps={{ name: 'code', placeholder: 'Enter Lot Number Scheme', maxLength: 200 }} /></FormField>
      <FormField><FormElement type="dropdown" label="Template Type" inputProps={{ name: 'templateType', placeholder: 'Select Template', options: [{ label: 'Sample COA', value: 'sample_coa' }, { label: 'Job Template', value: 'job_template' }, { label: 'Test Request', value: 'test_request' }] }} /></FormField>
      <FormField span={12}><FormElement label="Description" inputProps={{ name: 'description', placeholder: 'Enter description', maxLength: 10000 }} /></FormField>
    </FormSection>
  </FormPage>;
}
