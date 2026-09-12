'use client';

import { Profiler, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import MoreActionButton from '../ui/MoreActionButton.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';
import TemplateCanvas from './TemplateCanvas.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { DesignerDrawer, DesignerModal } from './DesignerDialogs.jsx';
import TemplateSettingsPanel from './TemplateSettingsPanel.jsx';
import { uploadTemplateImageFile } from './image-upload.js';
import '../../styles/template-designer.scss';

function StatPill({ label, value }) { return <span className="template-designer-stat-pill"><strong>{value}</strong><small>{label}</small></span>; }

export default function TemplateDesigner({ templateId, canManage }) {
  const router = useRouter();
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [editing, setEditing] = useState({});
  const [selected, setSelected] = useState(null);
  const [panel, setPanel] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    performance.mark('template:load-start');
    apiRequest(`/api/templates/${templateId}`, { signal: controller.signal }).then((result) => {
      const stateStart = performance.now();
      setModel(result.model);
      setError('');
      performance.measure('template:state-enqueue', { start: stateStart, end: performance.now() });
      performance.mark('template:data-ready');
      performance.measure('template:load', 'template:load-start', 'template:data-ready');
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [templateId, reload]);
  useLayoutEffect(() => {
    if (!model) return;
    const ready = performance.getEntriesByName('template:data-ready', 'mark').at(-1);
    if (ready) performance.measure('template:data-to-commit', { start: ready.startTime, end: performance.now() });
  }, [model]);

  const command = useCallback(async (operation) => {
    if (pending.current || !model) return false;
    if (operation.type === 'delete' && !window.confirm('Are you sure? This action cannot be undone.')) return false;
    pending.current = true;
    setBusy(true);
    const started = performance.now();
    try {
      let versionId = model.version.id;
      let revision = model.version.revision;
      if (model.version.status === 'frozen') {
        try {
          const draft = await apiRequest(`/api/template-versions/${versionId}/draft`, { method: 'POST', body: {} });
          versionId = draft.versionId; revision = draft.revision;
        } catch (failure) {
          if (failure.code !== 'draft_exists') throw failure;
          const current = await apiRequest(`/api/templates/${templateId}`);
          setModel(current.model);
          throw new Error('An editable draft already exists. Review it before applying this change.');
        }
      }
      const result = await apiRequest(`/api/template-versions/${versionId}`, { method: 'PATCH', body: { revision, command: operation } });
      setModel(result.model); setError('');
      if (operation.type === 'delete') setPanel(null);
      showToast('Updated successfully!', 'success');
      performance.measure('template:edit-save', { start: started, end: performance.now() });
      return true;
    } catch (failure) {
      setError(failure.message);
      showToast(failure.message, 'error');
      return false;
    } finally { pending.current = false; setBusy(false); }
  }, [model, templateId]);
  const toggleEdit = useCallback((id) => setEditing((previous) => ({ ...previous, [id]: !previous[id] })), []);
  const uploadImage = useCallback(async (fieldId, file) => {
    if (pending.current || !model) throw new Error('Wait for the current template change to finish.');
    pending.current = true; setBusy(true);
    try {
      let versionId = model.version.id; let revision = model.version.revision;
      if (model.version.status === 'frozen') {
        try {
          const draft = await apiRequest(`/api/template-versions/${versionId}/draft`, { method: 'POST', body: {} });
          versionId = draft.versionId; revision = draft.revision;
          setModel({ ...model, version: { ...model.version, id: versionId, revision, status: 'draft' } });
        } catch (failure) {
          if (failure.code !== 'draft_exists') throw failure;
          const current = await apiRequest(`/api/templates/${templateId}`); setModel(current.model);
          throw new Error('An editable draft already exists. Review it before uploading this image.');
        }
      }
      const result = await uploadTemplateImageFile(file, { versionId, fieldId, revision, requestId: crypto.randomUUID() });
      setModel(result.model); setError('');
    } finally { pending.current = false; setBusy(false); }
  }, [model, templateId]);

  if (!model) return error ? <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div></div> : <AppLoader message="Loading template..." />;
  return <>
    <PageHeader><div className="page-header page-header--template-designer"><div className="container-fluid">
      <div className="template-designer-toolbar">
        <div className="template-designer-toolbar__heading"><button type="button" className="template-designer-back" aria-label="Back to master templates" onClick={() => router.push('/master_template_management')}><AppIcon name="chevron-left" size={18} /><span>Back</span></button></div>
        <div className="template-designer-toolbar__stats" aria-label="Template structure summary"><StatPill label="Sections" value={Object.keys(model.sectionsById).length} /><StatPill label="Rows" value={Object.keys(model.rowsById).length} /><StatPill label="Columns" value={Object.keys(model.columnsById).length} /></div>
        <div className="template-designer-toolbar__actions">
          <div className="template-designer-zoom" aria-label="Canvas zoom controls"><button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom((value) => Math.max(0.25, value - 0.05))}>-</button><button type="button" className="template-designer-zoom__value" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 1} onClick={() => setZoom((value) => Math.min(1, value + 0.05))}>+</button></div>
          {canManage ? <button type="button" className="template-designer-action template-designer-action--secondary" disabled={busy} onClick={() => setPanel({ type: 'settings' })}><AppIcon name="settings" size={17} /><span>Settings</span></button> : null}
          <a href={`/master_template_management/${templateId}/preview?version=${model.version.id}`} target="_blank" rel="noopener noreferrer" className="template-designer-action template-designer-action--secondary view-preview"><AppIcon name="eye" size={17} /><span>Preview</span></a>
          {canManage ? <><button type="button" className="template-designer-action template-designer-action--primary add-container" disabled={busy} onClick={() => command({ type: 'addSection' })}><AppIcon name="plus" size={17} /><span>Add Container</span></button><MoreActionButton className="template-designer-more-actions" items={[{ key: 'edit-details', label: 'Edit Details', leftIcon: 'edit', onClick: () => setPanel({ type: 'details' }) }]} /></> : null}
        </div>
      </div>
    </div></div></PageHeader>
    {error ? <div className="alert alert-warning m-2" role="alert">{error}<button type="button" className="btn btn-link" disabled={busy} onClick={() => { setPanel(null); setReload((value) => value + 1); }}>Reload</button></div> : null}
    <div className="customContainer plan template-designer-page template-designer-modern" aria-busy={busy}>
      <div className="template-canvas-workspace"><div className="template-canvas-workspace__sheet" style={{ '--template-canvas-zoom': zoom }}>
        {model.rootSectionIds.length ? <Profiler id="template-canvas" onRender={(_id, phase, duration, _base, start) => performance.measure(`template:react-${phase}`, { start, duration })}>
          <TemplateCanvas model={model} mode={canManage ? 'plan' : 'view'} editing={editing} onToggleEdit={toggleEdit} onCommand={command} onPanel={setPanel} selected={selected} onSelect={setSelected} busy={busy} onUploadImage={uploadImage} showImagePlaceholder />
        </Profiler> : <div className="template-canvas-empty"><div className="template-canvas-empty__icon"><AppIcon name="file-text" size={26} /></div><h2>No containers yet</h2><p>Add a container to start building this printable template.</p>{canManage ? <button type="button" disabled={busy} onClick={() => command({ type: 'addSection' })}><AppIcon name="plus" size={17} /><span>Add Container</span></button> : null}</div>}
      </div></div>
    </div>
    {panel && ['row', 'section'].includes(panel.type) ? <DesignerDrawer key={`${panel.type}:${panel.id}`} panel={panel} model={model} onClose={() => setPanel(null)} onPanel={setPanel} onCommand={command} busy={busy} /> : null}
    {panel?.type === 'settings' ? <TemplateSettingsPanel model={model} onClose={() => setPanel(null)} onCommand={command} busy={busy} /> : null}
    {panel && !['row', 'section', 'settings'].includes(panel.type) ? <DesignerModal key={`${panel.type}:${panel.id}`} panel={panel} model={model} onClose={() => setPanel(null)} onCommand={command} busy={busy} /> : null}
  </>;
}
