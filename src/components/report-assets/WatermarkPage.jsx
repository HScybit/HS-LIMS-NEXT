'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AppIcon from '../ui/AppIcon.jsx';
import WatermarkForm from './WatermarkForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function WatermarkView({ watermark }) {
  const [lightboxOpen, setLightboxOpen] = useState(false); const closeRef = useRef(null); const previewRef = useRef(null);
  useEffect(() => {
    if (!lightboxOpen) return undefined;
    const preview = previewRef.current;
    closeRef.current?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') setLightboxOpen(false);
      if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); preview?.focus(); };
  }, [lightboxOpen]);
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody><tr>
      <td className="text-muted fw-semibold py-2 px-3 w-25">image</td><td className="py-2 px-3"><div className="d-flex align-items-center justify-content-between gap-2"><div className="text-break" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button ref={previewRef} type="button" className="border-0 bg-transparent p-0 align-self-start" aria-label="Enlarge watermark image" onClick={() => setLightboxOpen(true)}>
          <img src={watermark.imageUrl} alt={watermark.imageName} style={{ maxHeight: 60, maxWidth: 120, objectFit: 'cover', borderRadius: 4, border: '1px solid #dee2e6', cursor: 'zoom-in' }} />
        </button>
        <span><a href={watermark.imageUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}><AppIcon name="file-description" size={14} /><span>{watermark.imageName}</span></a>
          <a href={watermark.imageUrl} download={watermark.imageName} className="text-success" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, marginLeft: 20 }}><AppIcon name="arrow-down" size={14} /><span>Download file</span></a></span>
      </div></div></td>
    </tr></tbody></table></div>
    {lightboxOpen ? createPortal(<div role="dialog" aria-modal="true" aria-label="Watermark image" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999999 }}>
      <button ref={closeRef} type="button" aria-label="Close image" onClick={() => setLightboxOpen(false)} style={{ position: 'absolute', inset: 0, border: 0, background: 'transparent', cursor: 'zoom-out' }} />
      <img src={watermark.imageUrl} alt={watermark.imageName} style={{ maxHeight: '90vh', maxWidth: '90vw', borderRadius: 8, pointerEvents: 'none' }} />
    </div>, document.body) : null}
  </div></div></div>;
}

export default function WatermarkPage({ watermarkId, mode, canManage }) {
  const [watermark, setWatermark] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!watermarkId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/report-assets/watermarks/${watermarkId}`, { signal: controller.signal }).then((value) => { setWatermark(value); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [watermarkId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage watermarks.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div></div>;
  if (!watermarkId) return <WatermarkForm />;
  if (!watermark) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Watermark Report...</div></div>;
  return mode === 'view' ? <WatermarkView watermark={watermark} /> : <WatermarkForm key={watermark.id} watermark={watermark} />;
}
