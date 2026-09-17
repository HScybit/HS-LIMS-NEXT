'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { serviceAgreementFileAccept, serviceAgreementFileByteLimit, serviceAgreementFileMediaTypes } from '../../masters/service-agreement-file-config.js';

export default function ServiceAgreementFile({ value, disabled, onChange, onBusy }) {
  const input = useRef(null); const request = useRef(null); const controller = useRef(null);
  const [uploading, setUploading] = useState(false); const [failure, setFailure] = useState('');
  const url = value ? `/api/masters/service-agreements/files/${value.id}` : '';
  useEffect(() => () => { controller.current?.abort(); }, []);
  async function upload(file) {
    if (disabled || controller.current || !file) return;
    if (!file.size) { setFailure('Choose a nonempty attachment.'); return; }
    if (file.size > serviceAgreementFileByteLimit) { setFailure('Attachments can be at most 25 MiB.'); return; }
    if (!serviceAgreementFileMediaTypes.includes(file.type)) { setFailure('Choose a supported PDF, image, text, Word or Excel document.'); return; }
    if (request.current?.file !== file) request.current = { file, id: crypto.randomUUID() };
    const pending = request.current; const abort = new AbortController(); controller.current = abort;
    setUploading(true); setFailure(''); onBusy(true);
    try {
      const csrf = document.cookie.split('; ').find(item => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
      const response = await fetch('/api/masters/service-agreements/files', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: abort.signal, body: file,
        headers: { 'Content-Type': file.type, 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(file.name), 'X-Upload-Request-Id': pending.id } });
      let result;
      try { result = await response.json(); } catch { throw new Error('The upload response could not be read. Retry the upload.'); }
      if (!response.ok) throw new Error(result.error?.message ?? 'The upload failed. Retry the upload.');
      if (!abort.signal.aborted) { onChange(result); request.current = null; }
    } catch (error) { if (!abort.signal.aborted) setFailure(error.message); }
    finally { controller.current = null; if (!abort.signal.aborted) { setUploading(false); onBusy(false); } }
  }
  function remove() {
    if (disabled || uploading) return;
    onChange(null); setFailure(''); request.current = null;
    if (input.current) input.current.value = '';
  }
  return <div className="smplfy-form-field">
    <div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor="agreement-attachment">Attachment</label></div>
    <div className={`smplfy-file-field input-group${value ? '' : ' smplfy-form-empty'}${failure ? ' is-invalid' : ''}`}>
      <button type="button" className="smplfy-file-display form-control btn text-start" disabled={disabled || uploading}
        onClick={() => value ? window.open(`${url}?view=1`, '_blank', 'noopener,noreferrer') : input.current?.click()}>
        <span className={`text-truncate${value ? '' : ' text-secondary'}`}>{uploading ? 'Uploading...' : value?.originalName || 'Choose Agreement Document'}</span>
      </button>
      <button type="button" className={`smplfy-file-button smplfy-btn btn ${value ? 'btn-danger' : 'btn-light'} d-flex align-items-center justify-content-center`}
        disabled={disabled || uploading} aria-label={value ? 'Remove Attachment file' : 'Choose Attachment file'} onClick={value ? remove : () => input.current?.click()}>
        <AppIcon name={value ? 'trash' : 'file-description'} />
      </button>
      <input ref={input} id="agreement-attachment" type="file" accept={serviceAgreementFileAccept} className="visually-hidden" disabled={disabled || uploading}
        aria-invalid={failure ? 'true' : undefined} aria-describedby={failure ? 'agreement-attachment-error' : undefined}
        onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; void upload(selected); }} />
    </div>
    {value ? <div className="mt-2 p-2 border rounded bg-light d-flex align-items-center gap-3 flex-wrap">
      <span className="text-break small">{value.originalName}</span>
      <a href={`${url}?view=1`} target="_blank" rel="noopener noreferrer" className="btn btn-link text-indigo small p-0">View File</a>
      <a href={url} download={value.originalName} className="btn btn-link text-success small p-0">Download File</a>
    </div> : null}
    {uploading ? <div className="mt-2 small" role="status">Uploading...</div> : null}
    {failure ? <div id="agreement-attachment-error" className="text-danger small mt-1" role="alert">{failure}
      {request.current ? <button type="button" className="btn btn-link btn-sm" disabled={disabled || uploading} onClick={() => void upload(request.current?.file)}>Retry upload</button> : null}
    </div> : null}
  </div>;
}
