'use client';

import { Profiler, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';
import TemplateCanvas from './TemplateCanvas.jsx';
import TemplateOutline from './TemplateOutline.jsx';
import TemplateStudioToolbar from './TemplateStudioToolbar.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { BulkColumnClassesModal, PropertiesDock, PropertiesEditorModal, TemplateDetailsModal } from './DesignerDialogs.jsx';
import TemplateSettingsPanel from './TemplateSettingsPanel.jsx';
import { uploadTemplateImageFile } from './image-upload.js';
import { readClipboard } from './section-clipboard.js';
import { subscribeToTemplateEvents } from './live-events.js';
import '../../styles/template-designer.scss';
import '../../styles/template-studio.scss';

export default function TemplateDesigner({ templateId, canManage }) {
  const router = useRouter();
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const workspaceRef = useRef(null);
  const [designerMode, setDesignerMode] = useState(canManage ? 'configure' : 'view');
  const configureMode = designerMode === 'configure' && canManage;
  const [showOutline, setShowOutline] = useState(true);
  const [showProperties, setShowProperties] = useState(true);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [cloning, setCloning] = useState(false);
  const [selected, setSelected] = useState(null);
  const [panel, setPanel] = useState(null);
  const [editorPanel, setEditorPanel] = useState(null);
  const [bulkColumnIds, setBulkColumnIds] = useState(null);
  const [clipboard, setClipboard] = useState(() => (typeof window === 'undefined' ? null : readClipboard()));
  const closePanel = useCallback(() => { setPanel(null); setClipboard(readClipboard()); }, []);
  const openPanel = useCallback((nextPanel) => { setPanel(nextPanel); setShowProperties(true); }, []);
  const [zoom, setZoom] = useState(1);
  const [reload, setReload] = useState(0);
  const modelRef = useRef(model);
  // Below this width the panels become overlays, so they have to fold away on
  // resize too — not just on load — or they sit on top of the canvas.
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1180px)');
    const apply = () => {
      if (!narrow.matches) return;
      setShowOutline(false);
      setShowProperties(false);
    };
    const frame = window.requestAnimationFrame(apply);
    narrow.addEventListener('change', apply);
    return () => { window.cancelAnimationFrame(frame); narrow.removeEventListener('change', apply); };
  }, []);
  useEffect(() => { modelRef.current = model; }, [model]);
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

  // Live collaboration: another session editing this same template version refreshes this
  // canvas automatically instead of leaving it silently stale until the next local edit.
  useEffect(() => {
    if (!model?.version.id) return undefined;
    return subscribeToTemplateEvents((event) => {
      const current = modelRef.current;
      if (!current || event.templateVersionId !== current.version.id || pending.current) return;
      if (event.revision <= current.version.revision) return;
      const workspace = workspaceRef.current;
      const scroll = workspace ? { top: workspace.scrollTop, left: workspace.scrollLeft } : null;
      apiRequest(`/api/templates/${templateId}`).then((result) => {
        if (result.model.version.revision <= modelRef.current?.version.revision) return;
        setModel(result.model);
        if (scroll) requestAnimationFrame(() => { if (workspaceRef.current) { workspaceRef.current.scrollTop = scroll.top; workspaceRef.current.scrollLeft = scroll.left; } });
      }).catch(() => {});
    });
  }, [model?.version.id, templateId]);

  const command = useCallback(async (operation) => {
    if (pending.current || !model) return false;
    if (operation.type === 'delete' && !window.confirm('Are you sure? This action cannot be undone.')) return false;
    pending.current = true;
    setBusy(true); setSaveStatus('saving');
    const started = performance.now();
    const workspace = workspaceRef.current;
    const scroll = workspace ? { top: workspace.scrollTop, left: workspace.scrollLeft } : null;
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
      setModel(result.model); setError(''); setSaveStatus('saved');
      if (operation.type === 'delete') setPanel(null);
      showToast('Updated successfully!', 'success');
      performance.measure('template:edit-save', { start: started, end: performance.now() });
      if (scroll) requestAnimationFrame(() => { if (workspaceRef.current) { workspaceRef.current.scrollTop = scroll.top; workspaceRef.current.scrollLeft = scroll.left; } });
      return true;
    } catch (failure) {
      setError(failure.message);
      setSaveStatus('idle');
      showToast(failure.message, 'error');
      return false;
    } finally { pending.current = false; setBusy(false); }
  }, [model, templateId]);
  const cloneTemplate = useCallback(async () => {
    if (cloning || !model) return;
    setCloning(true);
    try {
      const cloned = await apiRequest(`/api/template-versions/${model.version.id}/clone`, { method: 'POST', body: {} });
      router.push(`/master_template_management/${cloned.templateId}`);
    } catch (failure) {
      setError(failure.message);
      showToast(failure.message, 'error');
    } finally { setCloning(false); }
  }, [cloning, model, router]);
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
  const previewUrl = `/master_template_management/${templateId}/preview?version=${model.version.id}`;
  const stats = {
    sections: Object.keys(model.sectionsById).length,
    rows: Object.keys(model.rowsById).length,
    columns: Object.keys(model.columnsById).length,
    widgets: Object.keys(model.fieldsById).length,
  };
  const dockPanel = ['section', 'sectionSettings', 'row', 'column', 'widget'].includes(panel?.type) ? panel : null;
  const pasteSection = async () => {
    const current = readClipboard();
    setClipboard(current);
    if (!current) {
      showToast('Copy a container before pasting it.', 'error');
      return;
    }
    if (await command({ type: 'pasteSection', sourceVersionId: current.versionId, sourceSectionId: current.sectionId })) setClipboard(readClipboard());
  };
  return <>
    <PageHeader><div className="page-header page-header--template-designer"><div className="container-fluid">
      <TemplateStudioToolbar canManage={canManage} cloning={cloning} busy={busy || saveStatus === 'saving'} mode={configureMode ? 'configure' : 'view'}
        onModeChange={(mode) => setDesignerMode(mode === 'configure' && canManage ? 'configure' : 'view')}
        onAddSection={() => command({ type: 'addSection' })} onClone={cloneTemplate} onEditDetails={() => setPanel({ type: 'details' })}
        onPasteSection={pasteSection} onProvideAccess={() => command({ type: 'grantAllRoleAccess' })} onSanitizeKeys={() => command({ type: 'sanitizeFieldKeys' })}
        onToggleInspector={() => setShowProperties((value) => !value)} onToggleOutline={() => setShowOutline((value) => !value)} inspectorOpen={showProperties} outlineOpen={showOutline}
        previewUrl={previewUrl} stats={stats} template={{ name: model.version.name, code: model.version.code, onBack: () => router.push('/master_template_management') }}
        zoom={zoom} onZoomIn={() => setZoom((value) => Math.min(1, Number((value + 0.1).toFixed(2))))} onZoomOut={() => setZoom((value) => Math.max(0.25, Number((value - 0.1).toFixed(2))))} onZoomReset={() => setZoom(1)} />
    </div></div></PageHeader>
    <div className={`customContainer plan template-designer-page template-designer-modern template-designer-studio is-${configureMode ? 'configure' : 'view'}-mode${configureMode && showOutline ? ' is-outline-open' : ''}${configureMode && showProperties ? ' is-inspector-open' : ''}`} aria-busy={busy} data-designer-mode={configureMode ? 'configure' : 'view'}>
      {configureMode && showOutline ? <TemplateOutline model={model} selected={selected} onSelect={setSelected} onPanel={openPanel} onCommand={command} busy={busy} onClose={() => setShowOutline(false)} previewUrl={previewUrl} /> : null}
      <main className="template-studio-canvas" aria-label="Template canvas">
        {error ? <div className="template-studio-message is-error" role="alert"><AppIcon name="alert-circle" size={18} /><div><strong>{error}</strong></div><button type="button" aria-label="Dismiss error" onClick={() => setError('')}><AppIcon name="close" size={16} /></button></div> : null}
        <div className="template-studio-canvas-intro"><div><span>{configureMode ? 'Configure mode' : 'View mode'}</span><strong>{configureMode ? 'Click any item to edit its properties' : 'Review the template without editing controls'}</strong></div><small>{configureMode ? 'Double-click a field to configure it' : canManage ? 'Switch to Configure to make changes' : 'You have view-only access'}</small></div>
        <div className="template-canvas-workspace" ref={workspaceRef}><div className="template-canvas-workspace__sheet" style={{ '--template-canvas-zoom': zoom }}>
          {model.rootSectionIds.length ? <Profiler id="template-canvas" onRender={(_id, phase, duration, _base, start) => performance.measure(`template:react-${phase}`, { start, duration })}>
            <TemplateCanvas model={model} mode={configureMode ? 'plan' : 'view'} onCommand={command} onPanel={openPanel} onEdit={setEditorPanel} onBulkEdit={setBulkColumnIds} selected={selected} onSelect={setSelected} busy={busy} onUploadImage={uploadImage} showImagePlaceholder />
          </Profiler> : <div id="template-designer" className="template-canvas-empty"><div className="template-canvas-empty__icon"><AppIcon name="file-text" size={26} /></div><h2>No containers yet</h2><p>Add a container to start building this printable template.</p>{configureMode ? <button type="button" disabled={busy} onClick={() => command({ type: 'addSection' })}><AppIcon name="plus" size={17} /><span>Add Container</span></button> : null}</div>}
        </div></div>
      </main>
      {configureMode && showProperties ? <PropertiesDock panel={dockPanel} model={model} onPanel={openPanel} onEdit={setEditorPanel} onClose={() => setShowProperties(false)} onCommand={command} busy={busy} /> : null}
    </div>
    <PropertiesEditorModal panel={editorPanel} model={model} onClose={() => setEditorPanel(null)} onCommand={command} busy={busy} />
    <BulkColumnClassesModal columnIds={bulkColumnIds} onClose={() => setBulkColumnIds(null)} onCommand={command} busy={busy} />
    {panel?.type === 'settings' ? <TemplateSettingsPanel model={model} onClose={closePanel} onCommand={command} busy={busy} /> : null}
    {panel?.type === 'details' ? <TemplateDetailsModal model={model} onClose={closePanel} onCommand={command} busy={busy} /> : null}
  </>;
}
