'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import Modal from '../ui/Modal.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { saveUserSignature } from '../../users/signature-client.js';
import { signatureCanPreview, userSignatureByteLimit } from '../../users/signature-policy.js';

export function UserSignaturePreview({ file, selectedFile, selectedUrl = '', detail = false, open: controlledOpen, onOpenChange }) {
  const [previewOpen, setPreviewOpen] = useState(false); const [failedUrl, setFailedUrl] = useState('');
  const open = controlledOpen ?? previewOpen; const setOpen = onOpenChange ?? setPreviewOpen;
  const url = selectedFile ? selectedUrl : file ? `${file.url}?view=1` : '';
  const name = selectedFile?.name ?? file?.originalName; const mediaType = selectedFile?.type ?? file?.mediaType;
  if (!file && !selectedFile) return <span>-</span>;
  const isImage = mediaType?.startsWith('image/'); const isPdf = mediaType === 'application/pdf';
  const preview = signatureCanPreview(mediaType);
  return <div className={detail ? 'user-signature-detail' : 'mt-2 p-2 border rounded bg-light'}>
    <div className="d-flex align-items-center gap-2 flex-wrap">
      {isImage && url && failedUrl !== url ? <button type="button" className="border-0 bg-transparent p-0" aria-label="Enlarge user signature" onClick={() => setOpen(true)}>
        <img src={url} alt={name || 'User signature'} onError={() => setFailedUrl(url)} style={{ maxHeight: detail ? 60 : 40, maxWidth: detail ? 120 : 40, objectFit: 'cover', borderRadius: 4 }} />
      </button> : <AppIcon name="file-description" size={24} />}
      <span className="small fw-semibold text-break">{name}</span>
      {selectedFile && preview ? <button type="button" className="btn btn-link small p-0" disabled={!url} onClick={() => setOpen(true)}>View File</button>
        : !selectedFile ? <a className="small" href={url} target="_blank" rel="noopener noreferrer">View File</a> : null}
      {url ? <a className="text-success small" href={selectedFile ? url : file.url} download={name}>Download File</a> : null}
    </div>
    {failedUrl === url ? <div className="form-text">This image cannot be previewed. The original file is available to download.</div> : null}
    {detail && isPdf && url ? <iframe src={url} sandbox="" title={name || 'User signature'} style={{ width: '100%', height: 200, border: '1px solid #dee2e6', borderRadius: 4 }} /> : null}
    <Modal open={open} title={name || 'User signature'} size="large" onClose={() => setOpen(false)}>
      {isImage ? <img src={url} alt={name || 'User signature'} style={{ maxHeight: '80vh', maxWidth: '100%' }} />
        : isPdf ? <iframe src={url} sandbox="" title={name || 'User signature'} style={{ width: '100%', height: '70vh' }} /> : null}
    </Modal>
  </div>;
}

export default function UserSignatureField({ userId, signature, selectedFile, onSelect, disabled, onPendingChange }) {
  const input = useRef(null); const [current, setCurrent] = useState(signature ?? { revision: 0, file: null });
  const [pending, setPending] = useState(null); const [saving, setSaving] = useState(false); const [error, setError] = useState(null); const [message, setMessage] = useState('');
  const [localPreview, setLocalPreview] = useState(null);
  const [fileOpen, setFileOpen] = useState(false);
  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview.url); }, [localPreview]);
  const blocked = disabled || saving || Boolean(pending); const shownFile = pending?.file ?? selectedFile;
  async function execute(command) {
    if (saving || disabled) return; setSaving(true); setError(null); setMessage(''); setPending(command); onPendingChange?.(true);
    try {
      await saveUserSignature(userId, command);
      const result = await apiRequest(`/api/users/${userId}/signature`);
      setCurrent(result); setPending(null); setLocalPreview(null); onPendingChange?.(false); setMessage(command.file ? 'Signature saved.' : 'Signature removed.');
    } catch (failure) { setError(failure); }
    finally { setSaving(false); }
  }
  async function reload() {
    setSaving(true);
    try { setCurrent(await apiRequest(`/api/users/${userId}/signature`)); setPending(null); setLocalPreview(null); onPendingChange?.(false); setError(null); setMessage('Current signature loaded.'); }
    catch (failure) { setError(failure); }
    finally { setSaving(false); }
  }
  function choose(event) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    if (file.size > userSignatureByteLimit) { setError(new Error('Signature files can be at most 20 MiB.')); return; }
    setError(null); setMessage(''); setFileOpen(false); setLocalPreview({ file, url: URL.createObjectURL(file) });
    if (userId) void execute({ file, requestId: crypto.randomUUID(), revision: current.revision }); else onSelect(file);
  }
  function remove() {
    if (userId) void execute({ file: null, requestId: crypto.randomUUID(), revision: current.revision });
    else { onSelect(null); setLocalPreview(null); setError(null); }
  }
  const hasFile = Boolean(shownFile || current.file);
  function openFile() {
    if (!hasFile) { input.current?.click(); return; }
    if (!shownFile) { window.open(`${current.file.url}?view=1`, '_blank', 'noopener,noreferrer'); return; }
    if (signatureCanPreview(shownFile.type)) { setFileOpen(true); return; }
    if (localPreview?.file === shownFile) { const link = document.createElement('a'); link.href = localPreview.url; link.download = shownFile.name; link.click(); }
  }
  return <div className="mb-3 smplfy-form-field"><div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor="user-signature-file">User Signature</label></div>
    <div className={`input-group smplfy-file-field${hasFile ? '' : ' smplfy-form-empty'}`}>
      <button type="button" className="smplfy-file-display form-control btn text-start" disabled={blocked} onClick={openFile}><span className={`text-truncate${hasFile ? '' : ' text-secondary'}`}>{shownFile?.name ?? current.file?.originalName ?? 'Upload the user signature here.'}</span></button>
      <button type="button" className={`smplfy-file-button smplfy-btn btn d-flex align-items-center justify-content-center ${hasFile ? 'btn-danger' : 'btn-light'}`} disabled={blocked} aria-label={hasFile ? 'Remove signature' : 'Choose signature'}
        onClick={hasFile ? remove : () => input.current?.click()}><AppIcon name={hasFile ? 'trash' : 'file-description'} size={16} /></button>
      <input id="user-signature-file" ref={input} type="file" className="visually-hidden" disabled={blocked} onChange={choose} />
    </div>
    {hasFile ? <UserSignaturePreview file={current.file} selectedFile={shownFile} selectedUrl={localPreview?.file === shownFile ? localPreview.url : ''} open={fileOpen} onOpenChange={setFileOpen} /> : null}
    {saving ? <div className="form-text" role="status">Saving signature…</div> : message ? <div className="form-text" role="status">{message}</div> : null}
    {!userId && selectedFile ? <div className="form-text">This signature will be uploaded after the user is created.</div> : null}
    {error ? <div className="text-danger small mt-2" role="alert">{error.message}
      {pending ? <button type="button" className="btn btn-link btn-sm" disabled={saving || disabled} onClick={() => execute(pending)}>Retry signature {pending.file ? 'upload' : 'removal'}</button> : null}
      {pending && [400, 403, 404, 409, 413, 422].includes(error.status) ? <button type="button" className="btn btn-link btn-sm" disabled={saving || disabled} onClick={reload}>Reload signature</button> : null}
    </div> : null}
  </div>;
}
