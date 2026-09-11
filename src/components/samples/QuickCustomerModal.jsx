'use client';

import { useState } from 'react';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { SampleTextField } from './SampleFormFields.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { quickCustomerInput } from '../../samples/input.js';

const fields = [
  { key: 'name', label: 'Name', maxLength: 250 }, { key: 'legalName', label: 'Legal Name', maxLength: 250 },
  { key: 'contactPersonName', label: 'Contact Person', maxLength: 200 }, { key: 'contactPersonEmail', label: 'Contact Person Email', type: 'email', maxLength: 320 },
  { key: 'contactPersonPhone', label: 'Contact Person Phone', maxLength: 50 },
  { key: 'billToAddress', label: 'Bill to Address', textarea: true, maxLength: 4000 }, { key: 'shipToAddress', label: 'Ship to Address', textarea: true, maxLength: 4000 },
];

export default function QuickCustomerModal({ onClose, onCreated }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((field) => [field.key, ''])));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const close = () => { if (!busy) onClose(); };
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const customer = await apiRequest('/api/samples/quick-customer', { method: 'POST', body: quickCustomerInput(values) });
      onCreated(customer);
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <Modal open title="Quick Add Customer" titleIcon="plus" size="md" onClose={close} actions={<>
    <SecondaryButton leftIcon="close" onClick={close} disabled={busy}>Cancel</SecondaryButton>
    <PrimaryButton type="submit" form="quick-add-customer-form" leftIcon="save" disabled={busy}>{busy ? 'Adding...' : 'Add Customer'}</PrimaryButton>
  </>}>
    <form id="quick-add-customer-form" className="d-flex flex-column gap-3" onSubmit={submit}>
      {error ? <div className="alert alert-danger mb-0" role="alert">{error}</div> : null}
      <div className="row g-3">{fields.map(({ key, ...field }) => <div className={field.textarea ? 'col-12' : 'col-12 col-md-6'} key={key}>
        <SampleTextField {...field} required rows={field.textarea ? 3 : undefined} value={values[key]} disabled={busy}
          onChange={(value) => setValues((current) => ({ ...current, [key]: value }))} />
      </div>)}</div>
    </form>
  </Modal>;
}
