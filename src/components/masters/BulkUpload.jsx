'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { masterBulkResources } from '../../masters/bulk-config.js';
import '../../styles/bulk-upload.scss';

export async function downloadBulkWorkbook(path, fileName) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const result = await response.json(); throw new Error(result.error?.message ?? 'The workbook could not be downloaded.');
  }
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');
  link.href = url; link.download = fileName; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BulkUploadModal({ resource, resources = [resource], open, onClose }) {
  const [model, setModel] = useState(resource);
  const router = useRouter(); const [file, setFile] = useState(null); const [busy, setBusy] = useState('');
  const [error, setError] = useState(''); const [uncertain, setUncertain] = useState(false);
  const pending = useRef(null); const running = useRef(false); const mounted = useRef(true); const controller = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  async function download() {
    if (running.current) return; running.current = true; setBusy('download'); setError('');
    try { await downloadBulkWorkbook(`/api/master-bulk/sample?resource=${model}`, `${model}-sample.xlsx`); }
    catch (failure) { if (mounted.current) setError(failure.message); }
    finally { running.current = false; if (mounted.current) setBusy(''); }
  }
  async function upload(event) {
    event.preventDefault(); if (running.current) return;
    if (!file) { setError('Choose a CSV or XLSX file.'); return; }
    if (!pending.current) pending.current = { id: crypto.randomUUID(), resource: model, file, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    running.current = true; setBusy('upload'); setError(''); const command = pending.current;
    controller.current = new AbortController();
    try {
      const csrf = document.cookie.split('; ').find(item => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
      const response = await fetch(`/api/master-bulk?resource=${command.resource}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.current.signal,
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(command.file.name),
          'X-Upload-Request-Id': command.id, 'X-Upload-Time-Zone': command.timeZone }, body: command.file });
      const result = await response.json();
      if (!response.ok) { const failure = new Error(result.error?.message ?? 'Upload failed.'); failure.status = response.status; throw failure; }
      pending.current = null;
      if (mounted.current) { setUncertain(false); onClose(); router.push(`/bulk_uploads/${result.id}`); }
    } catch (failure) {
      if (!mounted.current) return;
      const unknown = !failure.status || failure.status >= 500;
      if (!unknown) pending.current = null;
      setUncertain(unknown); setError(unknown ? 'The upload result could not be confirmed. Retry to check the same upload.' : failure.message);
    } finally { running.current = false; if (mounted.current) setBusy(''); }
  }
  return <Modal open={open} title="Bulk Upload Data" size="large" onClose={() => { if (!running.current && !uncertain) onClose(); }} actions={<>
    <SecondaryButton leftIcon="download" disabled={Boolean(busy) || uncertain} onClick={download}>{busy === 'download' ? 'Preparing…' : 'Download Sample Excel'}</SecondaryButton>
    <PrimaryButton leftIcon="upload" type="submit" form="bulk-upload-form" disabled={Boolean(busy)}>{busy === 'upload' ? 'Uploading…' : uncertain ? 'Retry upload' : 'Upload'}</PrimaryButton>
  </>}>
    <form id="bulk-upload-form" className="bulk-upload-form" onSubmit={upload}>
      <div className="alert alert-info">Download the sample file, keep its headers, and upload the completed CSV or XLSX file.
        <strong className="d-block mt-1">Maximum 2,500 data rows, 250 columns and 16 MiB per file.</strong>
        {model === 'users' ? <span className="d-block mt-1">User uploads create new accounts. Supply an active Role and Lab for each user. Passwords are hidden in previews and downloaded files.</span> : null}</div>
      <div className="row g-3"><div className="col-12 col-md-5"><label className="form-label" htmlFor="bulk-model">Select Model</label>
        <select id="bulk-model" className="form-select" value={model} disabled={Boolean(busy) || uncertain} onChange={event => { setModel(event.target.value); setError(''); }}>
          {resources.map(value => <option key={value} value={value}>{masterBulkResources[value].label}</option>)}</select></div>
      <div className="col-12 col-md-7"><label className="form-label" htmlFor="bulk-file">Select File</label>
        <input id="bulk-file" type="file" className="form-control" accept=".csv,.xlsx" disabled={Boolean(busy) || uncertain}
          onChange={event => { setFile(event.target.files?.[0] ?? null); pending.current = null; setError(''); }} /></div></div>
      {error ? <div className="alert alert-danger mb-0" role="alert">{error}</div> : null}
      <Link href={`/bulk_uploads?resource=${model}`} onClick={event => { if (running.current || uncertain) event.preventDefault(); }}>View previous uploads</Link>
    </form>
  </Modal>;
}

export default function MasterBulkButton({ resource, resources }) {
  const [open, setOpen] = useState(false);
  return <><SecondaryButton leftIcon="upload" onClick={() => setOpen(true)}>Bulk Upload</SecondaryButton>
    {open ? <BulkUploadModal resource={resource} resources={resources} open onClose={() => setOpen(false)} /> : null}</>;
}
