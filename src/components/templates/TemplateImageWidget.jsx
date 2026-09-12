'use client';

import { useState } from 'react';

export default function TemplateImageWidget({ field, value, mode, sources, onUpload, disabled, showPlaceholder }) {
  const [uploading, setUploading] = useState(false); const [error, setError] = useState(''); const [failedSource, setFailedSource] = useState(null);
  const id = value?.state === 'present' && value.imageId ? value.imageId : field.defaultImageId;
  const image = sources?.[id]; const config = field.image ?? {};
  async function selectFile(event) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || disabled || uploading) return;
    setError('');
    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) { setError('Only image files are allowed.'); return; }
    setUploading(true);
    try { await onUpload(field.id, file); }
    catch (failure) { setError(failure.message || 'Unable to upload image.'); }
    finally { setUploading(false); }
  }
  return <div className={`d-flex justify-content-${config.alignment ?? 'start'}`}>
    <div style={{ width: `${config.widthPercent ?? 100}%`, margin: `${config.marginTop ?? 0}px ${config.marginRight ?? 0}px ${config.marginBottom ?? 0}px ${config.marginLeft ?? 0}px` }}>
      {mode === 'plan' ? <><input type="file" accept="image/*" className="form-control task-input-file" aria-label={`Template image ${field.alias || field.label || ''}`.trim()}
        disabled={disabled || uploading || !onUpload} onChange={selectFile} />
        {uploading ? <div className="form-text text-muted" role="status">Uploading image...</div> : null}
        {error ? <div className="form-text text-danger" role="alert">{error}</div> : null}</> : null}
      {image && failedSource !== image.src ? <picture><source media="print" srcSet={image.printSrc} />
        {/* Immutable, validated local bytes; retain the source image sizing and animation. */}
        <img className="img-fluid tiw_image" src={image.src} alt="" onError={() => setFailedSource(image.src)} />
      </picture> : id ? <div className="form-text text-muted">Image preview unavailable.</div>
        : showPlaceholder ? <div className="border rounded text-muted text-center py-3 small">No template image selected</div> : null}
    </div>
  </div>;
}
