'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { showToast } from '../ui/toast.jsx';
import { SampleFormSection, SampleTextField, SampleSelectField, optionList } from './SampleFormFields.jsx';
import SampleProductCard from './SampleProductCard.jsx';
import QuickCustomerModal from './QuickCustomerModal.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { newRegistration, newProduct, sampleKinds, changeSampleKind, estimatedAmount, estimatedReportingDate, registrationPayload } from '../../samples/form.js';
import { sampleEditForm, sampleEditPayload, sampleEditReportingDate, sampleFormEditPolicy, retainedSampleOption } from '../../samples/edit-form.js';

const formId = 'new-sample-v2-form';
const iqcTypes = [{ value: 'repetition', label: 'Replicate' }, { value: 'retest', label: 'Retest' }, { value: 'blind', label: 'Blind' }, { value: 'int_lab', label: 'Intra Lab' }];

export default function SampleRegistration({ requestedKind, receivedByName, canCreate, canRead, sampleId, canManage }) {
  const router = useRouter();
  const editing = Boolean(sampleId); const canUse = editing ? canManage && canRead : canCreate;
  const [form, setForm] = useState(() => newRegistration(requestedKind, receivedByName));
  const [editingSample, setEditingSample] = useState(null);
  const [options, setOptions] = useState(null); const [loadError, setLoadError] = useState(''); const [reload, setReload] = useState(0);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [saved, setSaved] = useState('');
  const [imageUploads, setImageUploads] = useState(() => new Set());
  const onImageBusy = useCallback((key, uploading) => setImageUploads(current => {
    if (current.has(key) === uploading) return current;
    const next = new Set(current); if (uploading) next.add(key); else next.delete(key); return next;
  }), []);
  const updateProduct = useCallback((key, changes) => setForm(current => ({ ...current,
    products: current.products.map(product => product.key === key ? { ...product, ...changes } : product),
  })), []);
  const removeProduct = useCallback(key => setForm(current => ({ ...current, products: current.products.filter(product => product.key !== key) })), []);
  useEffect(() => {
    if (!canUse) return;
    const controller = new AbortController();
    async function load() {
      try {
        const [choices, sample] = await Promise.all([
          apiRequest('/api/samples/registration-options', { signal: controller.signal }),
          sampleId ? apiRequest(`/api/samples/${sampleId}`, { signal: controller.signal }) : null,
        ]);
        if (!controller.signal.aborted) {
          setOptions(choices); setLoadError(''); setEditingSample(sample);
          if (sample) setForm(sampleEditForm(sample));
        }
      } catch (failure) { if (!controller.signal.aborted) setLoadError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [canUse, sampleId, reload]);
  if (!canUse) return <div className="alert alert-warning m-4" role="alert">You do not have permission to {editing ? 'edit' : 'register'} samples.</div>;
  if (!options || (editing && !editingSample)) return loadError ? <div className="alert alert-danger m-4" role="alert">{loadError}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message={editing ? 'Loading sample...' : 'Loading sample registration...'} />;
  if (editing && !editingSample.canEdit) return <div className="alert alert-warning m-4" role="alert">The current workflow state does not allow editing this sample.</div>;

  const kind = sampleKinds.find((item) => item.value === form.kind);
  const standardKinds = sampleKinds.filter((item) => !['iqc', 'amendment', 'complaint'].includes(item.value));
  const kindOptions = standardKinds.some((item) => item.value === form.kind) ? standardKinds : [kind, ...standardKinds];
  const title = editing ? 'Edit Sample' : `New ${kind.title || kind.label} Sample`;
  const policy = editing ? sampleFormEditPolicy(editingSample, options) : null;
  const locked = key => busy || (editing && !policy.headers.has(key));
  const dueAt = editing ? sampleEditReportingDate(form, editingSample, options).dueAt : form.dueAt || estimatedReportingDate(form, options);
  const customer = options.customers.find((item) => item.id === form.customerId);
  const customers = retainedSampleOption(optionList(options.customers), form.customerId, editingSample?.customerId, editingSample?.customerName);
  const quotations = retainedSampleOption((customer?.quotations ?? []).map(item => ({ value: item.id, label: item.quotationNumber })),
    form.customerQuotationId, form.customerId === editingSample?.customerId ? editingSample.customerQuotationId : null, editingSample?.quotationNumber);
  const participantRequired = form.kind === 'intralab' || (form.kind === 'iqc' && form.iqcType === 'int_lab');
  const setField = (key, value) => { setSaved(''); setForm((current) => ({ ...current, [key]: value })); };
  const textField = (key, label, props = {}) => <SampleTextField label={label} value={form[key]} disabled={locked(key)} onChange={(value) => setField(key, value)} {...props} />;
  function changeCustomer(id, choices = options.customers) {
    const selected = choices.find((item) => item.id === id);
    const address = selected?.addresses.find((item) => item.addressType === 'billing' && item.isDefault)
      ?? selected?.addresses.find((item) => item.addressType === 'billing') ?? selected?.addresses[0];
    setForm((current) => ({ ...current, customerId: id, customerAddress: address?.text ?? '', customerQuotationId: '' }));
  }
  async function submit(event) {
    event.preventDefault(); if (busy || imageUploads.size) return;
    setError(''); setBusy(true);
    try {
      const body = editing ? sampleEditPayload(form, editingSample, options) : registrationPayload(form, options);
      const sample = await apiRequest(editing ? `/api/samples/${sampleId}` : '/api/samples', { method: editing ? 'PATCH' : 'POST', body });
      showToast(editing ? 'Sample Updated.' : 'Sample Created.', 'success');
      if (canRead) router.push(`/samples/${sample.id}`);
      else { setSaved(`Sample ${sample.sampleNumber} registered.`); setForm(newRegistration(form.kind, receivedByName)); setBusy(false); }
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <>
    <PageHeader><section className="page-header"><div className="container-fluid h-100"><div className="row page-header__row h-100 align-items-center justify-content-between gx-0">
      <div className="col page-header__start"><div className="page-title-wrap">{canRead ? <SecondaryButton size="medium" className="page-header__back" aria-label={editing ? 'Back to sample details' : 'Back to all samples'} href={editing ? `/samples/${sampleId}` : '/samples'} disabled={busy}><AppIcon name="chevron-left" /></SecondaryButton> : null}<h1 className="page-title mb-0">{title}</h1></div></div>
      <div className="col-auto"><div className="page-header__actions"><PrimaryButton type="submit" form={formId} leftIcon="save" disabled={busy || imageUploads.size > 0}>{busy ? 'Saving...' : editing ? 'Update Sample' : 'Save Sample'}</PrimaryButton></div></div>
    </div></div></section></PageHeader>
    <div className="sample-form-page min-vh-100 bg-body-tertiary"><main className="sample-form-page__body px-4 py-4 pb-5">
      {error ? <div className="sample-form-error-banner-slot"><div className="alert alert-danger sample-form-error-banner d-flex align-items-center justify-content-between gap-3" role="alert"><span>{error}</span><button type="button" className="btn-close" aria-label="Dismiss error" onClick={() => setError('')} /></div></div> : null}
      {saved ? <div className="alert alert-success" role="status">{saved}</div> : null}
      <form id={formId} className="container-xl px-0" onSubmit={submit}><div className="d-grid gap-3">
        <SampleFormSection id="new-sample-customer-details" title="Customer Details"><div className="container-fluid p-4"><div className="row g-4">
          <div className="col-lg-6"><SampleSelectField label="Sample Type" required value={form.kind} options={kindOptions} placeholder="Select sample type" disabled={busy || editing}
            onChange={(value) => { if (value) { setSaved(''); setForm((current) => changeSampleKind(current, value)); } }} /></div>
          {participantRequired ? <div className="col-lg-6">{textField('participantCount', 'No. of Participants', { type: 'number', min: 1, step: 1, required: true, placeholder: 'e.g. 5', disabled: busy || editing })}</div> : null}
          {form.kind === 'ilc' ? <div className="col-12"><div className="sample-form-validation-group">
            <div className="d-flex align-items-center justify-content-between gap-3 mb-2"><label className="smplfy-form-label form-label mb-0">ILC Labs <span className="text-danger">*</span></label>
              <button type="button" className="smplfy-btn btn btn-outline-secondary btn-sm" disabled={busy || editing || form.participatingLabs.length >= 100} onClick={() => setField('participatingLabs', [...form.participatingLabs, { key: crypto.randomUUID(), laboratoryName: '' }])}><AppIcon name="plus" /><span>Add Lab</span></button>
            </div><div className="d-grid gap-2">{form.participatingLabs.map((lab, index) => <div className="d-flex align-items-center gap-2" key={lab.key}>
              <div className="flex-fill"><SampleTextField value={lab.laboratoryName} aria-label={`ILC lab ${index + 1}`} placeholder="Enter lab name" maxLength={250} disabled={busy || editing}
                onChange={(value) => setField('participatingLabs', form.participatingLabs.map((item) => item.key === lab.key ? { ...item, laboratoryName: value } : item))} /></div>
              <button type="button" className="smplfy-btn btn btn-outline-danger btn-sm" aria-label="Remove lab" disabled={busy || editing} onClick={() => setField('participatingLabs', form.participatingLabs.filter((item) => item.key !== lab.key))}><AppIcon name="trash" /></button>
            </div>)}</div>
          </div></div> : null}
          <div className="col-lg-6">{textField('receivedAt', 'Receiving Date', { type: 'date', required: true, disabled: locked('receivedAt') || !options.allowReceivingDateEdit })}</div>
          <div className="col-lg-6"><div className="d-flex align-items-end gap-3"><div className="flex-fill"><SampleSelectField label="Customer" required={!editing || editingSample.sampleType === 'customer'} value={form.customerId} options={customers} placeholder="Select a Customer or create new" disabled={locked('customerId')} onChange={(value) => changeCustomer(value)} /></div>
            <PrimaryButton type="button" aria-label="Add customer" leftIcon="plus" onClick={() => setQuickCustomerOpen(true)} disabled={locked('customerId') || !canCreate} /></div></div>
          <div className="col-lg-6"><SampleSelectField label="Customer Quotation" value={form.customerQuotationId} options={quotations} placeholder="Select quotation" disabled={locked('customerQuotationId') || !form.customerId} onChange={(value) => {
            const quotation = customer?.quotations.find((item) => item.id === value);
            setForm((current) => ({ ...current, customerQuotationId: value, totalAmount: quotation?.totalAmount ?? current.totalAmount, currencyCode: quotation?.currencyCode ?? current.currencyCode }));
          }} /></div>
          <div className="col-12">{textField('customerAddress', 'Customer Address', { textarea: true, rows: 3, required: Boolean(form.customerId), maxLength: 5000 })}</div>
          {form.kind === 'iqc' ? <div className="col-lg-6"><SampleSelectField label="IQC Type" required value={form.iqcType} options={iqcTypes} placeholder="Select IQC type" disabled={busy || editing} onChange={(value) => setField('iqcType', value)} /></div> : null}
        </div></div></SampleFormSection>
        <SampleFormSection id="new-sample-product-details" title="Product Details"><div className="container-fluid p-4"><div className="sample-form-products d-grid gap-4">
          {form.products.map((product, index) => <SampleProductCard key={product.key} onImageBusy={onImageBusy} product={product} index={index} kind={form.kind} currency={form.currencyCode} options={options} disabled={busy || (editing && !policy.products)}
            savedProduct={editingSample?.products.find(line => line.id === product.id)} canEditRetest={!busy && Boolean(policy?.retests)}
            onChange={updateProduct} onRemove={removeProduct} />)}
        </div><hr className="my-4" /><button className="smplfy-btn btn btn-outline-secondary w-100 py-3 add_new_product_btn" type="button" disabled={busy || (editing && !policy.products) || form.products.length >= 100}
          onClick={() => setField('products', [...form.products, newProduct(form.products[0]?.sampleCategoryId)])}><AppIcon name="plus" /><span>Add New Product</span></button></div></SampleFormSection>
        <SampleFormSection id="new-sample-additional-details" title="Additional Details"><div className="container-fluid p-4"><div className="row g-4">
          <div className="col-lg-6">{textField('modeOfReceipt', 'Mode of Sample Receipt', { maxLength: 200 })}</div>
          <div className="col-lg-6"><SampleTextField label="Tentative Reporting Date" type="date" required={!editing} value={dueAt} disabled={locked('dueAt')} onChange={(value) => setField('dueAt', value)} /></div>
          <div className="col-lg-6"><SampleTextField label="Amount" type="number" min="0" step="any" value={!editing && form.totalAmount === '' ? estimatedAmount(form.products, form.kind) : form.totalAmount} disabled={locked('totalAmount')} onChange={(value) => setField('totalAmount', value)} /></div>
          <div className="col-lg-6">{textField('receivedByName', 'Received By', { maxLength: 200 })}</div>
          <div className="col-12">{textField('collectionDetails', 'Sample Collection Details', { textarea: true, rows: 3, maxLength: 5000 })}</div>
          {form.kind === 'amendment' ? <div className="col-12">{textField('amendmentRemarks', 'Amendment Remarks', { textarea: true, rows: 3, maxLength: 5000 })}</div> : null}
          {form.kind === 'complaint' ? <div className="col-12">{textField('complaintRemarks', 'Complaint Remarks', { textarea: true, rows: 3, maxLength: 5000 })}</div> : null}
        </div></div></SampleFormSection>
      </div></form>
    </main></div>
    {quickCustomerOpen ? <QuickCustomerModal onClose={() => setQuickCustomerOpen(false)} onCreated={(created) => {
      const customers = [...options.customers, created]; setOptions((current) => ({ ...current, customers })); changeCustomer(created.id, customers); setQuickCustomerOpen(false);
    }} /> : null}
  </>;
}
