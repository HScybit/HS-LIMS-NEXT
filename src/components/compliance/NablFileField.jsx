'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';

async function uploadFile(file, requestId, signal) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Attachments can be at most 25 MiB.');
  const csrf = document.cookie.split('; ').find(item => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  const response = await fetch('/api/operations/nabl-certifications/files', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(file.name), 'X-Upload-Request-Id': requestId } });
  let result; try { result = await response.json(); } catch { throw new Error('The upload response could not be read. Retry the upload.'); }
  if (!response.ok) throw new Error(result.error?.message ?? 'The upload failed. Retry the upload.');
  return result;
}
export default function NablFileField({ name, label, value, disabled, onChange, onBusy }) {
  const input = useRef(null); const request = useRef(null); const controller = useRef(null); const pending = useRef(false);
  const [uploading, setUploading] = useState(false); const [failure, setFailure] = useState('');
  const id = `nabl-file-${name}`; const url = value?.url;
  useEffect(() => () => controller.current?.abort(), []);
  async function upload(file) {
    if (!file || disabled || pending.current) return;
    if (request.current?.file !== file) request.current = { file, id: crypto.randomUUID() };
    const attempt = request.current; const abort = new AbortController(); controller.current = abort;
    pending.current = true; setUploading(true); setFailure(''); onBusy(name, true);
    try {
      const result = await uploadFile(file, attempt.id, abort.signal);
      if (!abort.signal.aborted) { onChange(result); request.current = null; onBusy(name, false); }
    } catch (error) { if (!abort.signal.aborted) setFailure(error.message); }
    finally { if (!abort.signal.aborted) { pending.current = false; setUploading(false); } }
  }
  function clear(clearValue = true) {
    if (disabled || pending.current) return;
    request.current = null; setFailure(''); onBusy(name, false); if (clearValue) onChange(null);
  }
  return <div className="smplfy-form-field mb-3">
    <div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor={id}>{label}</label></div>
    <div className={`smplfy-file-field input-group${value ? '' : ' smplfy-form-empty'}${failure ? ' is-invalid' : ''}`}>
      <button type="button" className="smplfy-file-display form-control btn text-start" disabled={disabled || uploading}
        onClick={() => value ? window.open(`${url}?view=1`, '_blank', 'noopener,noreferrer') : input.current?.click()}>
        <span className={`text-truncate${value ? '' : ' text-secondary'}`}>{uploading ? 'Uploading...' : value?.originalName || `Upload ${label}`}</span>
      </button>
      {value ? <button type="button" className="smplfy-file-button smplfy-btn btn btn-danger" disabled={disabled || uploading} aria-label={`Remove ${label} file`} onClick={() => clear()}><AppIcon name="trash" /></button>
        : <button type="button" className="smplfy-file-button smplfy-btn btn btn-light" disabled={disabled || uploading} aria-label={`Choose ${label} file`} onClick={() => input.current?.click()}><AppIcon name="file-description" /></button>}
      <input ref={input} id={id} name={name} type="file" accept="*" className="visually-hidden" disabled={disabled || uploading} aria-describedby={failure ? `${id}-error` : undefined}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} />
    </div>
    {value ? <div className="mt-2 p-2 border rounded bg-light d-flex align-items-center gap-2"><AppIcon name="file-description" />
      <div className="text-truncate small">{value.originalName}</div><a href={`${url}?view=1`} target="_blank" rel="noopener noreferrer" className="btn btn-link btn-sm text-nowrap">View File</a>
      <a href={url} download={value.originalName} className="btn btn-link btn-sm text-nowrap">Download File</a></div> : null}
    {uploading ? <div role="status" className="small mt-1">Uploading...</div> : null}
    {failure ? <div id={`${id}-error`} role="alert" className="text-danger small mt-1">{failure}
      <button type="button" className="btn btn-link btn-sm" disabled={disabled || uploading} onClick={() => void upload(request.current?.file)}>Retry upload</button>
      <button type="button" className="btn btn-link btn-sm" disabled={disabled || uploading} onClick={() => clear(false)}>Discard upload</button></div> : null}
  </div>;
}
