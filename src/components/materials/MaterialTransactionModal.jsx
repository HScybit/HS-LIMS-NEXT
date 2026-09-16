'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import MaterialChoice from './MaterialChoice.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { parseVisibleDate } from '../ui/date-input.js';

const types = [['in', 'In'], ['out', 'Out'], ['out_damaged', 'Out - Damaged']];
export default function MaterialTransactionModal({ material: initialMaterial, onClose, onSaved }) {
  const [material, setMaterial] = useState(null); const [reload, setReload] = useState(0); const [loadingError, setLoadingError] = useState('');
  const [draft, setDraft] = useState({ type: 'in', quantity: '', cost: '', supplier: '', batchSerialNumber: '', expiryDate: '' });
  const [batch, setBatch] = useState(null); const [batchCheck, setBatchCheck] = useState({ exists: false, error: '' });
  const [error, setError] = useState(''); const [errors, setErrors] = useState({}); const [saving, setSaving] = useState(false);
  const id = useRef(null); const request = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest(`/api/materials/${initialMaterial.id}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setMaterial(result.material); setLoadingError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setLoadingError(failure.message); });
    return () => controller.abort();
  }, [initialMaterial.id, reload]);
  useEffect(() => {
    if (draft.type !== 'in' || !draft.batchSerialNumber.trim()) return undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      apiRequest(`/api/materials/${initialMaterial.id}/batch-check?batch=${encodeURIComponent(draft.batchSerialNumber)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setBatchCheck({ exists: result.exists, error: '' }); })
        .catch(failure => { if (!controller.signal.aborted) setBatchCheck({ exists: false, error: failure.message }); });
    }, 200);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [draft.type, draft.batchSerialNumber, initialMaterial.id]);
  function change(key, value) {
    setDraft(current => ({ ...current, [key]: value })); setErrors(current => ({ ...current, [key]: '' }));
    if (key === 'batchSerialNumber') setBatchCheck({ exists: false, error: '' });
  }
  function changeType(type) {
    setDraft(current => ({ ...current, type, batchSerialNumber: '' })); setBatch(null); setBatchCheck({ exists: false, error: '' }); setErrors({}); setError('');
  }
  async function save(event) {
    event.preventDefault(); if (saving || !material) return;
    const next = {};
    if (!draft.quantity.trim() || !Number.isFinite(Number(draft.quantity)) || Number(draft.quantity) <= 0) next.quantity = 'Enter a value greater than zero.';
    if (draft.type === 'in') {
      if (!draft.cost.trim() || !Number.isFinite(Number(draft.cost)) || Number(draft.cost) < 0) next.cost = 'Enter zero or a positive cost.';
      if (!draft.batchSerialNumber.trim()) next.batchSerialNumber = 'Batch/Serial No. is required.';
      if (material.categoryExpirable && !parseVisibleDate(draft.expiryDate)?.iso) next.expiryDate = 'Enter a valid expiry date.';
    } else if (!batch || batch.exhausted) next.batchSerialNumber = 'Select an available batch.';
    setErrors(next); if (Object.keys(next).length) return;
    id.current ??= crypto.randomUUID();
    const body = { ...draft, id: id.current, batchSerialNumber: draft.type === 'in' ? draft.batchSerialNumber : batch.batchSerialNumber,
      supplier: draft.type === 'in' ? draft.supplier : batch.supplier, cost: draft.type === 'in' ? draft.cost : null, expiryDate: draft.type === 'in' && material.categoryExpirable ? parseVisibleDate(draft.expiryDate).iso : '' };
    const content = JSON.stringify(body);
    if (isIn && batchCheck.exists && request.current?.content !== content) { setErrors({ batchSerialNumber: 'This Batch/Serial No already exists. Enter a unique one.' }); return; }
    if (request.current?.content !== content) request.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try { const result = await apiRequest(`/api/materials/${material.id}/transactions`, { method: 'POST', body: { ...body, requestId: request.current.id } }); onSaved(result); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }
  const isIn = draft.type === 'in';
  return <Modal open title={material?.name ?? initialMaterial.name} subtitle="New Transaction" titleIcon="arrows-exchange" cardClassName="smplfy-transaction-modal"
    onClose={() => { if (!saving) onClose(); }} actions={<>
      <SecondaryButton leftIcon="close" disabled={saving} onClick={onClose}>Cancel</SecondaryButton>
      <PrimaryButton type="submit" form="materials-transaction-form" leftIcon="save" disabled={saving || !material || Boolean(loadingError)}>{saving ? 'Saving...' : 'Save'}</PrimaryButton>
    </>}>
    {loadingError ? <div className="alert alert-warning" role="alert">{loadingError}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div>
      : !material ? <div role="status">Loading material...</div> : <form id="materials-transaction-form" onSubmit={save} className="d-flex flex-column gap-4" noValidate>
        {error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Reload material</button></div> : null}
        <div className="smplfy-transaction-type-pills nav nav-pills p-1 bg-body-tertiary border rounded" role="tablist" aria-label="Transaction type">
          {types.map(([type, label]) => <button key={type} type="button" className={`smplfy-nav-link nav-link smplfy-nav-link-medium flex-fill${draft.type === type ? ' active' : ''}`} role="tab"
            aria-selected={draft.type === type} disabled={saving} onClick={() => changeType(type)}><span className="d-inline-flex align-items-center">{label}</span></button>)}
        </div>
        <div className="row g-3"><div className="col-12 col-md-6"><FormElement label="Quantity" mandatory message={errors.quantity} messageTone="error"
          inputProps={{ type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: draft.quantity, disabled: saving, onChange: event => change('quantity', event.target.value) }} /></div>
          {isIn ? <div className="col-12 col-md-6"><FormElement label="Cost" mandatory message={errors.cost} messageTone="error" inputProps={{ type: 'number', min: '0', step: 'any', value: draft.cost, disabled: saving, onChange: event => change('cost', event.target.value) }} /></div> : null}
          <div className="col-12"><FormElement label="Unit (UoM)" inputProps={{ value: material.unitName, disabled: true }} /></div>
          {isIn ? <><div className="col-12"><FormElement label="Make/Supplier" inputProps={{ value: draft.supplier, maxLength: 250, disabled: saving, onChange: event => change('supplier', event.target.value) }} /></div>
            <div className="col-12"><FormElement label="Batch/Serial No." mandatory message={errors.batchSerialNumber || (batchCheck.exists ? 'This Batch/Serial No already exists. Enter a unique one.' : '')} messageTone="error"
              inputProps={{ value: draft.batchSerialNumber, maxLength: 150, disabled: saving, onChange: event => change('batchSerialNumber', event.target.value) }} />
              {batchCheck.error ? <div className="small text-danger" role="alert">{batchCheck.error}</div> : null}</div>
            {material.categoryExpirable ? <div className="col-12"><FormElement type="date" label="Expiry Date" mandatory message={errors.expiryDate} messageTone="error"
              inputProps={{ value: draft.expiryDate, disabled: saving, onChange: event => change('expiryDate', event.target.value) }} /></div> : null}</> : <>
              <div className="col-12"><MaterialChoice kind="batch" materialId={material.id} label="Batch/Serial No." value={batch?.id ?? ''} selected={batch} message={errors.batchSerialNumber} disabled={saving}
                onChange={(_value, option) => { setBatch(option ?? null); setErrors(current => ({ ...current, batchSerialNumber: '' })); }} /></div>
              {batch ? <div className="col-12"><div className="text-secondary small">Available: {batch.availableQuantity} {material.unitName}</div><FormElement label="Make/Supplier" inputProps={{ value: batch.supplier ?? '', disabled: true }} /></div> : null}
            </>}
        </div>
      </form>}
  </Modal>;
}
