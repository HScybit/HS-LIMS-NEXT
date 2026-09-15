'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { uploadCustomFieldFile } from '../../custom-fields/attachment-client.js';

export default function MasterCustomFieldFile({ kind, field, value, stored, disabled, error, onChange, onBusy }) {
  const input = useRef(null); const request = useRef(null); const controller = useRef(null);
  const [uploading, setUploading] = useState(false); const [failure, setFailure] = useState(''); const [uploaded, setUploaded] = useState(null);
  const id = `${kind}-custom-field-${field.id}`; const fileId = String(value ?? '').trim().toLowerCase();
  const file = uploaded?.id === fileId ? uploaded : stored?.items.find((item) => item.attachmentId === fileId)?.attachment;
  const name = file?.originalName || fileId;
  const url = fileId ? `${kind === 'user' ? '/api/users/custom-fields/attachments' : '/api/custom-fields/attachments'}/${encodeURIComponent(fileId)}` : '';
  useEffect(() => () => { controller.current?.abort(); }, []);

  async function upload(file) {
    if (disabled || uploading || !file) return;
    if (request.current?.file !== file) request.current = { file, id: crypto.randomUUID(), field: { id: field.id, revision: field.revision } };
    const pending = request.current; const abort = new AbortController(); controller.current = abort;
    setUploading(true); setFailure(''); onBusy(field.id, true);
    try {
      const result = await uploadCustomFieldFile(pending.field, file, pending.id, abort.signal, { userFields: kind === 'user' });
      if (!abort.signal.aborted) { setUploaded(result); onChange(result.id); request.current = null; }
    } catch (failure) {
      if (!abort.signal.aborted) setFailure(failure.message);
    } finally {
      if (!abort.signal.aborted) { setUploading(false); onBusy(field.id, false); }
    }
  }
  function remove() {
    if (disabled || uploading) return;
    onChange(''); setUploaded(null); setFailure(''); request.current = null;
    if (input.current) input.current.value = '';
  }
  const removeButton = (className, size) => <button type="button" className={className} disabled={disabled || uploading}
    title="Remove file" aria-label={`Remove ${field.label} file`} onClick={remove}><AppIcon name="trash" size={size} /></button>;
  return <div className="mb-3 smplfy-form-field">
    <div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor={id}>{field.label}</label>
      {field.isRequired ? <span className="smplfy-form-required">*</span> : null}</div>
    <div className={`smplfy-file-field input-group${fileId ? '' : ' smplfy-form-empty'}${error || failure ? ' is-invalid' : ''}${uploading ? ' smplfy-form-focused' : ''}`}>
      <button type="button" className="smplfy-file-display form-control btn text-start" disabled={disabled || uploading}
        onClick={() => fileId ? window.open(`${url}?view=1`, '_blank', 'noopener,noreferrer') : input.current?.click()}>
        <span className={`text-truncate${fileId ? '' : ' text-secondary'}`}>{uploading ? 'Uploading...' : name || `Upload ${field.label}`}</span>
      </button>
      {fileId ? removeButton('smplfy-file-button smplfy-btn btn btn-danger d-flex align-items-center justify-content-center', '16px') :
        <button type="button" className="smplfy-file-button smplfy-btn btn btn-light d-flex align-items-center justify-content-center"
          disabled={disabled || uploading} title="Choose file" aria-label={`Choose ${field.label} file`} onClick={() => input.current?.click()}>
          {uploading ? <span className="spinner-border spinner-border-sm" aria-hidden="true" /> : <AppIcon name="file-description" />}
        </button>}
      <input ref={input} id={id} name={id} type="file" accept="*" className="visually-hidden" disabled={disabled || uploading}
        aria-invalid={error || failure ? 'true' : undefined} aria-describedby={error || failure ? `${id}-error` : undefined}
        onChange={(event) => { const selected = event.target.files?.[0]; event.target.value = ''; void upload(selected); }} />
    </div>
    {fileId ? <div className="mt-2 p-2 border rounded bg-light"><div className="d-flex align-items-center justify-content-between">
      <div className="d-flex align-items-center gap-2 flex-grow-1" style={{ minWidth: 0 }}>
        {['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file?.mediaType)
          ? <img src={`${url}?view=1`} alt={name} style={{ maxHeight: '40px', maxWidth: '40px', objectFit: 'cover' }} />
          : <AppIcon name="file-description" size="24px" />}
        <div className="flex-grow-1" style={{ minWidth: 0 }}><div className="text-truncate small font-weight-bold">{name}</div>
          <span className="m-2"><a href={`${url}?view=1`} target="_blank" rel="noopener noreferrer" className="btn btn-link text-indigo small p-0">View File</a></span>
          <span><a href={url} download={name} className="btn btn-link text-success small p-0">Download File</a></span>
        </div>
      </div>{removeButton('btn btn-sm btn-danger flex-shrink-0', '14px')}
    </div></div> : null}
    {uploading ? <div className="mt-2 small" role="status"><span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />Uploading...</div> : null}
    {failure || error ? <div id={`${id}-error`} className="smplfy-form-element__message smplfy-form-element__message--error mt-1" role="alert">
      {failure || error}{failure ? <button type="button" className="btn btn-link btn-sm" disabled={disabled || uploading}
        onClick={() => void upload(request.current?.file)}>Retry upload</button> : null}
    </div> : null}
  </div>;
}
