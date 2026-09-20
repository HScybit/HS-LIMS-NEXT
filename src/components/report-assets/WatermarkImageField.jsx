'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { uploadReportImageFile } from './image-upload.js';

export default function WatermarkImageField({ image, disabled, error, onChange, onUploadBlocked }) {
  const inputRef = useRef(null); const pending = useRef(null);
  const [uploadError, setUploadError] = useState(''); const [uploading, setUploading] = useState(false);
  useEffect(() => () => pending.current?.controller.abort(), []);

  async function upload(attempt) {
    pending.current?.controller.abort();
    const active = { ...attempt, controller: new AbortController() }; pending.current = active;
    setUploading(true); setUploadError(''); onUploadBlocked(true); onChange(null);
    try {
      const result = await uploadReportImageFile(active.file, { requestId: active.requestId, signal: active.controller.signal });
      if (active.controller.signal.aborted) return;
      onChange({ id: result.id, url: result.url, name: result.originalName });
      pending.current = null; onUploadBlocked(false);
    } catch (failure) {
      if (!active.controller.signal.aborted) setUploadError(failure.message);
    } finally { if (!active.controller.signal.aborted) setUploading(false); }
  }
  function remove() {
    pending.current?.controller.abort(); pending.current = null;
    onChange(null); onUploadBlocked(false); setUploadError(''); setUploading(false);
  }
  return <div className="mb-3 smplfy-form-element">
    <div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor="watermark-image">Upload Image</label><span className="smplfy-form-required">*</span></div>
    <div className={`smplfy-file-field input-group ${image ? '' : 'smplfy-form-empty'} ${uploading ? 'smplfy-form-focused' : ''}`}>
      <button type="button" className={`smplfy-file-display form-control btn text-start ${error ? 'is-invalid' : ''}`} disabled={disabled || uploading}
        onClick={() => image ? window.open(image.url, '_blank', 'noopener,noreferrer') : inputRef.current?.click()}>
        <span className={`text-truncate ${image ? '' : 'text-secondary'}`}>{uploading ? 'Uploading...' : image?.name || 'Upload Upload Image'}</span>
      </button>
      {image || uploadError ? <button type="button" className="smplfy-file-button smplfy-btn btn btn-danger d-flex align-items-center justify-content-center"
        title="Remove file" disabled={disabled || uploading} onClick={remove}><AppIcon name="trash" size={16} /></button>
        : <button type="button" className="smplfy-file-button smplfy-btn btn btn-light d-flex align-items-center justify-content-center"
          title="Choose file" disabled={disabled || uploading} onClick={() => inputRef.current?.click()}><AppIcon name="file-description" /></button>}
      <input ref={inputRef} id="watermark-image" name="image" className="visually-hidden" type="file" accept="image/*" disabled={disabled || uploading}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'watermark-image-error' : undefined} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void upload({ file, requestId: crypto.randomUUID() });
        }} />
    </div>
    {image ? <div className="mt-2 p-2 border rounded bg-light"><div className="d-flex align-items-center justify-content-between">
      <div className="d-flex align-items-center gap-2 flex-grow-1 min-width-0">
        {/* Captured original bytes are served by the authenticated image endpoint. */}
        <img src={image.url} alt={image.name} style={{ maxHeight: 40, maxWidth: 40, objectFit: 'cover' }} />
        <div className="flex-grow-1 min-width-0"><div className="text-truncate small font-weight-bold">{image.name}</div>
          <span className="m-2"><a href={image.url} target="_blank" rel="noopener noreferrer" className="btn btn-link text-indigo small p-0">View File</a></span>
          <span><a href={image.url} target="_blank" rel="noopener noreferrer" className="btn btn-link text-success small p-0" download={image.name}>Download File</a></span>
        </div>
      </div><button type="button" className="btn btn-sm btn-danger" title="Remove file" disabled={disabled} onClick={remove}><AppIcon name="trash" size={14} /></button>
    </div></div> : null}
    {uploading ? <div className="mt-2" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" /><span className="ms-2 small">Uploading...</span></div> : null}
    {uploadError ? <div className="alert alert-danger mt-2 mb-0 py-2 small" role="alert">{uploadError}<button type="button" className="btn btn-link btn-sm" disabled={disabled} onClick={() => void upload(pending.current)}>Retry upload</button></div> : null}
    {error ? <div id="watermark-image-error" className="smplfy-form-element__message smplfy-form-element__message--error mt-1 text-danger small">{error}</div> : null}
  </div>;
}
