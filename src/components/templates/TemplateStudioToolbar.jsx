'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';

function MoreActions({ busy, cloning, onClone, onEditDetails, onProvideAccess, onSanitizeKeys }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const choose = (callback) => {
    setOpen(false);
    callback();
  };

  return <div ref={rootRef} className={`template-studio-more dropdown${open ? ' show' : ''}`}>
    <button type="button" className="template-studio-toolbar-button is-icon" disabled={busy} aria-label="More template actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}><AppIcon name="more" size={19} /></button>
    {open ? <div className="dropdown-menu show" role="menu" aria-label="More template actions">
      <button type="button" className="dropdown-item" role="menuitem" onClick={() => choose(onEditDetails)}><AppIcon name="edit" size={16} />Edit template details</button>
      <button type="button" className="dropdown-item" role="menuitem" onClick={() => choose(onProvideAccess)}><AppIcon name="user-plus" size={16} />Give access to all roles</button>
      <button type="button" className="dropdown-item" role="menuitem" onClick={() => choose(onSanitizeKeys)}><AppIcon name="refresh" size={16} />Sanitize field keys</button>
      <button type="button" className="dropdown-item" role="menuitem" disabled={cloning} onClick={() => choose(onClone)}><AppIcon name="fa-copy" size={16} />{cloning ? 'Cloning template…' : 'Clone template'}</button>
    </div> : null}
  </div>;
}

export default function TemplateStudioToolbar({ canManage, cloning, busy, mode, onModeChange, onAddSection, onClone, onEditDetails, onPasteSection, onProvideAccess, onSanitizeKeys, onToggleInspector, onToggleOutline, inspectorOpen, outlineOpen, previewUrl, stats, template, zoom, onZoomIn, onZoomOut, onZoomReset }) {
  return <div className="template-studio-toolbar">
    <div className="template-studio-toolbar__identity">
      <button type="button" className="template-studio-back" aria-label="Back to templates" onClick={template.onBack}><AppIcon name="chevron-left" size={19} /></button>
      <div className="template-studio-toolbar__title">
        <span>Template studio</span>
        <h1>{template.name}</h1>
        <p>{template.code} · {stats.sections} container{stats.sections === 1 ? '' : 's'} · {stats.widgets} field{stats.widgets === 1 ? '' : 's'}</p>
      </div>
    </div>
    <div className="template-studio-toolbar__status" role="status" aria-live="polite">
      <span className={busy ? 'is-saving' : mode === 'view' ? 'is-viewing' : 'is-saved'}>{busy ? <AppIcon name="refresh" size={14} /> : <AppIcon name={mode === 'view' ? 'eye' : 'check'} size={14} />}</span>
      <span>{busy ? 'Saving changes…' : mode === 'view' ? 'Viewing template' : 'All changes saved'}</span>
    </div>
    <div className="template-studio-toolbar__actions">
      <div className="template-studio-mode-switch" role="group" aria-label="Designer mode">
        <button type="button" className={mode === 'configure' ? 'is-active' : ''} aria-pressed={mode === 'configure'} disabled={!canManage || busy} title={canManage ? 'Configure template' : 'You have view-only access'} onClick={() => onModeChange('configure')}><AppIcon name="settings" size={15} /><span>Configure</span></button>
        <button type="button" className={mode === 'view' ? 'is-active' : ''} aria-pressed={mode === 'view'} disabled={busy} title="View template" onClick={() => onModeChange('view')}><AppIcon name="eye" size={15} /><span>View</span></button>
      </div>
      {mode === 'configure' ? <button type="button" className={`template-studio-toolbar-button is-panel-toggle${outlineOpen ? ' is-active' : ''}`} aria-pressed={outlineOpen} onClick={onToggleOutline}><AppIcon name="list" size={17} /><span>Outline</span></button> : null}
      <div className="template-studio-zoom" aria-label="Canvas zoom">
        <button type="button" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={onZoomOut}>−</button>
        <button type="button" className="template-studio-zoom__value" title="Reset zoom" onClick={onZoomReset}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="Zoom in" disabled={zoom >= 1} onClick={onZoomIn}>+</button>
      </div>
      <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="template-studio-toolbar-button"><AppIcon name="file-text" size={17} /><span>Print Preview</span></a>
      {mode === 'configure' && canManage ? <button type="button" className="template-studio-toolbar-button" disabled={busy} onClick={onPasteSection}><AppIcon name="fa-clipboard" size={17} /><span>Paste</span></button> : null}
      {mode === 'configure' && canManage ? <button type="button" className="template-studio-toolbar-button is-primary" disabled={busy} onClick={onAddSection}><AppIcon name="plus" size={17} /><span>Container</span></button> : null}
      {mode === 'configure' ? <button type="button" className={`template-studio-toolbar-button is-panel-toggle${inspectorOpen ? ' is-active' : ''}`} aria-pressed={inspectorOpen} onClick={onToggleInspector}><AppIcon name="settings" size={17} /><span>Properties</span></button> : null}
      {mode === 'configure' && canManage ? <MoreActions busy={busy} cloning={cloning} onClone={onClone} onEditDetails={onEditDetails} onProvideAccess={onProvideAccess} onSanitizeKeys={onSanitizeKeys} /> : null}
    </div>
  </div>;
}
