'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
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
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    {error ? <div className="alert alert-warning" role="alert">{error}</div> : null}
    <form onSubmit={submit} autoComplete="off"><div className="row g-3">
      <div className="col-12"><FormElement label="Name" mandatory inputProps={{ name: 'name', placeholder: 'Enter name', maxLength: 200 }} /></div>
      <div className="col-12"><FormElement label="Description" inputProps={{ name: 'description', placeholder: 'Enter description', maxLength: 10000 }} /></div>
      <div className="col-12"><FormElement label="UUID" inputProps={{ name: 'code', placeholder: 'Enter Lot Number Scheme', maxLength: 200 }} /></div>
      <div className="col-12"><FormElement type="dropdown" label="Template Type" inputProps={{ name: 'templateType', placeholder: 'Select Template', options: [{ label: 'Sample COA', value: 'sample_coa' }, { label: 'Job Template', value: 'job_template' }, { label: 'Test Request', value: 'test_request' }] }} /></div>
      <div className="col-12 d-flex justify-content-end gap-2"><SecondaryButton type="button" disabled={busy} onClick={() => router.push('/master_template_management')}>Cancel</SecondaryButton><PrimaryButton type="submit" disabled={busy}>Save</PrimaryButton></div>
    </div></form>
  </div></div></div></div></div>;
}
