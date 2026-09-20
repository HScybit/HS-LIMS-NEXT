'use client';

import { useRef, useState } from 'react';

async function uploadLogo(file, signal) {
  if (file.size > 2 * 1024 * 1024) throw new Error('The logo must be at most 2 MiB.');
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  const response = await fetch('/api/organization-settings/logo', { method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal, body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(file.name) } });
  let result; try { result = await response.json(); } catch { throw new Error('The upload response could not be read. Retry the upload.'); }
  if (!response.ok) throw new Error(result.error?.message ?? 'The logo upload failed. Retry the upload.');
  return result;
}

// Uploads immediately on file selection (its own PUT endpoint, binary body), unlike the rest of this
// form which stages a draft until "Save Settings" — the logo endpoint only accepts raw bytes, and
// there is no benefit to deferring an image upload behind the JSON settings save.
export default function LogoUpload({ disabled, logo, onUploaded }) {
  const inputRef = useRef(null); const controllerRef = useRef(null);
  const [uploading, setUploading] = useState(false); const [failure, setFailure] = useState('');
  async function handleChange(event) {
    const file = event.target.files[0]; if (!file) return;
    const abort = new AbortController(); controllerRef.current = abort;
    setUploading(true); setFailure('');
    try { onUploaded(await uploadLogo(file, abort.signal)); }
    catch (error) { if (!abort.signal.aborted) setFailure(error.message); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  }
  return <div className="row gx-3">
    <div className="col-md-6"><div className="smplfy-form-element mb-3">
      <div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="organization_logo_upload">Upload New Logo</label></div>
      <input ref={inputRef} className="smplfy-form-control form-control" id="organization_logo_upload" type="file" accept="image/png,image/jpeg,image/webp"
        disabled={disabled || uploading} onChange={handleChange} />
      <div className="smplfy-form-element__helper">PNG, JPEG or WebP. Max 2 MB.</div>
      {uploading ? <span className="badge bg-secondary mt-2">Uploading…</span> : null}
      {failure ? <div className="alert alert-danger mt-2 mb-0" role="alert">{failure}</div> : null}
    </div></div>
    <div className="col-md-6"><div className="smplfy-form-element mb-3">
      <div className="smplfy-form-element__label-row"><span className="smplfy-form-element__label">Current Logo</span></div>
      {logo ? <img src={logo.url} alt="Organization logo" style={{ maxHeight: 96, maxWidth: '100%' }} /> : <span className="text-muted small">No logo uploaded</span>}
    </div></div>
  </div>;
}
