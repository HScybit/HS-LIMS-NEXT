'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';

export default function SampleImageField({ productKey, imageFileId, image, disabled, onChange, onBusy }) {
  const [uploading, setUploading] = useState(false); const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState(null);
  const controller = useRef(null); const pending = useRef(null);
  const input = useRef(null); const selectedName = useRef('');
  const id = `sample-image-${productKey}`;
  useEffect(() => () => { controller.current?.abort(); onBusy(productKey, false); }, [productKey, onBusy]);
  async function upload(file) {
    if (!file || disabled || uploading) return;
    setError('');
    if (!file.size || file.size > 10 * 1024 * 1024) { setError('Select a non-empty image of at most 10 MiB.'); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('Product images must be JPEG, PNG or WebP files.'); return; }
    const abort = new AbortController(); controller.current = abort;
    selectedName.current = file.name;
    setUploading(true); onBusy(productKey, true);
    try {
      // File metadata alone cannot distinguish replacement bytes or a retry.
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      if (abort.signal.aborted) return;
      const signature = `${file.name}:${file.type}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (pending.current?.signature !== signature) pending.current = { signature, id: crypto.randomUUID() };
      const csrf = document.cookie.split('; ').find(item => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
      const response = await fetch('/api/samples/images', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: abort.signal, body: file,
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Upload-Request-Id': pending.current.id, 'X-CSRF-Token': csrf } });
      let result;
      try { result = await response.json(); } catch { throw new Error('The upload response could not be read. Retry the upload.'); }
      if (!response.ok) {
        if (response.status === 409) pending.current = null;
        throw new Error(result.error?.message ?? 'The image upload failed. Retry the upload.');
      }
      if (!abort.signal.aborted) { onChange({ imageFileId: result.id, image: result }); setPreviewError(null); pending.current = null; }
    } catch (failure) { if (!abort.signal.aborted) setError(failure.message); }
    finally { if (!abort.signal.aborted) setUploading(false); onBusy(productKey, false); }
  }
  const name = uploading ? selectedName.current : image?.originalName ?? '';
  return <>
    <div className="smplfy-form-field">
      <div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor={id}>Image Upload</label>
        {imageFileId ? <div className="smplfy-form-label-actions"><button type="button" className="smplfy-btn btn btn-outline-danger btn-sm" title="Remove image" aria-label="Remove uploaded sample image"
          disabled={disabled || uploading} onClick={() => { onChange({ imageFileId: null, image: null }); setError(''); }}><AppIcon name="trash" size={14} /></button></div> : null}
      </div>
      <div className={`smplfy-file-field input-group${name ? '' : ' smplfy-form-empty'}${error ? ' is-invalid' : ''}`}>
        <button type="button" className={`smplfy-file-display form-control btn${error ? ' is-invalid' : ''}`} disabled={disabled || uploading}
          aria-label={name || 'Select sample image'} onClick={() => input.current?.click()}><span className={`text-truncate${name ? '' : ' text-secondary'}`}>{name}</span></button>
        <button type="button" className="smplfy-file-button smplfy-btn btn btn-light" disabled={disabled || uploading} aria-label="Choose file" onClick={() => input.current?.click()}>
          <span className="d-inline-flex align-items-center justify-content-center" aria-hidden="true"><AppIcon name="file-description" /></span>
        </button>
        <input ref={input} id={id} type="file" accept="image/*" className="visually-hidden" disabled={disabled || uploading}
          aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} />
      </div>
      {error ? <div id={`${id}-error`} className="smplfy-form-feedback invalid-feedback d-block">{error}</div> : null}
    </div>
    {uploading ? <div className="form-text" role="status">Uploading image...</div> : null}
    {imageFileId && previewError !== imageFileId ? <img className="img-thumbnail mt-2 sample-form-image-preview" src={`/api/samples/images/${imageFileId}`} alt="Product"
      onError={() => setPreviewError(imageFileId)} /> : null}
    {imageFileId && previewError === imageFileId ? <div className="form-text text-danger mt-2">Image preview unavailable.</div> : null}
  </>;
}
