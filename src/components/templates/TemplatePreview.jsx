'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBlobRequest, apiRequest } from '../../lib/api-client.js';
import TemplateCanvas from './TemplateCanvas.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { buildPreviewDocument } from './template-preview-document.js';
import '../../styles/template-preview.scss';

function NumberField({ label, value, min = '0', max, step = '1', onChange }) {
  return <label className="template-print-config-field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function CheckboxRow({ label, checked, onChange }) {
  return <label className="template-print-config-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

export default function TemplatePreview({ templateId, versionId }) {
  const htmlRootRef = useRef(null);
  const [model, setModel] = useState(null);
  const [activeMode, setActiveMode] = useState('html');
  const [variant, setVariant] = useState('non_nabl');
  const [configOpen, setConfigOpen] = useState(false);
  const [printConfig, setPrintConfig] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfStatus, setPdfStatus] = useState('idle');
  const [pdfError, setPdfError] = useState('');
  const [pdfDirty, setPdfDirty] = useState(false);
  const [configStatus, setConfigStatus] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const query = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
    apiRequest(`/api/templates/${templateId}${query}`, { signal: controller.signal }).then((result) => {
      setModel(result.model);
      setPrintConfig(result.model.version.printConfig);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [templateId, versionId]);

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  const generatePdf = useCallback(async () => {
    if (!htmlRootRef.current || !model || !printConfig) return;
    setPdfStatus('loading');
    setPdfError('');
    try {
      const blob = await apiBlobRequest(`/api/templates/${templateId}/preview-pdf`, { body: {
        html: buildPreviewDocument(htmlRootRef.current, model.version.name), title: model.version.name, variant, printConfig,
      } });
      const nextUrl = URL.createObjectURL(blob);
      setPdfUrl((current) => { if (current) URL.revokeObjectURL(current); return nextUrl; });
      setPdfDirty(false);
      setPdfStatus('ready');
    } catch (failure) {
      setPdfError(failure.message);
      setPdfStatus('error');
    }
  }, [model, printConfig, templateId, variant]);

  useEffect(() => { if (activeMode === 'pdf' && !pdfUrl && model) void generatePdf(); }, [activeMode, generatePdf, model, pdfUrl]);

  function updateConfig(key, value) {
    setPrintConfig((current) => ({ ...current, [key]: value }));
    setPdfDirty(true);
    setConfigStatus('');
  }

  async function saveConfig() {
    setSavingConfig(true);
    setConfigStatus('');
    try {
      const saved = await apiRequest(`/api/templates/${templateId}/print-config`, { method: 'PUT', body: printConfig });
      setPrintConfig(saved);
      setConfigStatus('Print config saved');
    } catch (failure) {
      setConfigStatus(failure.message);
    } finally { setSavingConfig(false); }
  }

  if (error) return <main className="template-print-preview template-print-preview--empty"><section className="template-print-preview__empty"><h1>Preview unavailable</h1><p>{error}</p><button type="button" onClick={() => window.close()}>Close</button></section></main>;
  if (!model || !printConfig) return <AppLoader message="Loading template preview..." fullPage />;

  return <main className="template-print-preview">
    <header className="template-print-preview__toolbar">
      <div className="template-print-preview__title"><p>Template Preview</p><h1>{model.version.name}</h1></div>
      <div className="template-print-preview__controls">
        <div className="template-print-preview__segmented" role="group" aria-label="Preview mode"><button type="button" className={activeMode === 'html' ? 'is-active' : ''} onClick={() => setActiveMode('html')}>HTML</button><button type="button" className={activeMode === 'pdf' ? 'is-active' : ''} onClick={() => setActiveMode('pdf')}>PDF</button></div>
        <label className="template-print-preview__inline-field"><span>View</span><select aria-label="View" value={variant} onChange={(event) => { setVariant(event.target.value); setPdfDirty(true); }}><option value="non_nabl">Non NABL</option><option value="nabl">NABL</option></select></label>
        {activeMode === 'pdf' ? <>{pdfDirty && pdfUrl ? <span className="template-print-preview__refresh-hint">Refresh PDF to apply config changes</span> : null}<button type="button" onClick={generatePdf} disabled={pdfStatus === 'loading'}>{pdfStatus === 'loading' ? 'Generating' : 'Refresh PDF'}</button></> : null}
        <button type="button" className={configOpen ? 'is-active' : ''} onClick={() => setConfigOpen((current) => !current)}>Print Config</button>
        <button type="button" onClick={() => { if (window.opener) window.close(); else window.history.back(); }}>Close</button>
      </div>
    </header>
    <section className="template-print-preview__workspace">
      <div className={`template-print-preview__html ${activeMode === 'html' ? 'is-active' : 'is-measuring'}`}>
        <article className="template-preview-document" ref={htmlRootRef}>
          {printConfig.printHeader ? <header className="template-preview-document__header" data-is-header="true" style={{ textAlign: printConfig.headerAlignment }}><strong>{model.version.name}</strong></header> : null}
          <div id="template-designer"><TemplateCanvas model={model} mode="view" variant={variant} coaMode printMode showImagePlaceholder /></div>
          {printConfig.printFooter ? <footer className="template-preview-document__footer" data-is-footer="true" style={{ textAlign: printConfig.footerAlignment }}>{model.version.code}</footer> : null}
        </article>
      </div>
      {activeMode === 'pdf' ? <section className="template-print-preview__pdf" aria-live="polite">{pdfStatus === 'loading' ? <div className="template-print-preview__state"><span className="template-print-preview__spinner" /><strong>Generating PDF preview</strong></div> : null}{pdfStatus === 'error' ? <div className="template-print-preview__state template-print-preview__state--error"><strong>{pdfError}</strong><button type="button" onClick={generatePdf}>Retry</button></div> : null}{pdfUrl ? <iframe className="template-print-preview__frame" title="Template PDF preview" src={pdfUrl} /> : null}</section> : null}
      {configOpen ? <aside className="template-print-config-panel" aria-label="Print config"><div className="template-print-config-panel__header"><div><p>Preview</p><h2>Print Config</h2></div><button type="button" onClick={() => setConfigOpen(false)}>Close</button></div><div className="template-print-config-panel__body">
        <div className="template-print-config-grid template-print-config-grid--three"><label className="template-print-config-field"><span>Page Size</span><select aria-label="Page Size" value={printConfig.pageSize} onChange={(event) => updateConfig('pageSize', event.target.value)}>{['A3', 'A4', 'A5', 'Letter', 'Legal'].map((size) => <option key={size}>{size}</option>)}</select></label><NumberField label="Scale" min="0.1" max="1" step="0.05" value={printConfig.scale} onChange={(value) => updateConfig('scale', value)} /><NumberField label="X-Axis Margin" max="500" value={printConfig.xMargin} onChange={(value) => updateConfig('xMargin', value)} /></div>
        <div className="template-print-config-check-grid"><CheckboxRow label="Landscape" checked={printConfig.isLandscape} onChange={(value) => updateConfig('isLandscape', value)} /><CheckboxRow label="Show Header" checked={printConfig.printHeader} onChange={(value) => updateConfig('printHeader', value)} /><CheckboxRow label="Show Footer" checked={printConfig.printFooter} onChange={(value) => updateConfig('printFooter', value)} /></div>
        <div className="template-print-config-grid template-print-config-grid--two">{[['headerAlignment', 'Print Header'], ['footerAlignment', 'Print Footer']].map(([key, label]) => <label className="template-print-config-field" key={key}><span>{label}</span><select aria-label={label} value={printConfig[key]} onChange={(event) => updateConfig(key, event.target.value)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>)}</div>
        <div className="template-print-config-section-label">Non NABL Margins</div><div className="template-print-config-grid template-print-config-grid--two"><NumberField label="Top Margin(px)" max="2000" value={printConfig.nonNablTopMargin} onChange={(value) => updateConfig('nonNablTopMargin', value)} /><NumberField label="Bottom Margin(px)" max="2000" value={printConfig.nonNablBottomMargin} onChange={(value) => updateConfig('nonNablBottomMargin', value)} /></div><div className="template-print-config-check-grid"><CheckboxRow label="Use Custom Top Margin?" checked={printConfig.useCustomTopNonNabl} onChange={(value) => updateConfig('useCustomTopNonNabl', value)} /><CheckboxRow label="Use Custom Bottom Margin?" checked={printConfig.useCustomBottomNonNabl} onChange={(value) => updateConfig('useCustomBottomNonNabl', value)} /></div>
        <div className="template-print-config-section-label">NABL Margins</div><div className="template-print-config-grid template-print-config-grid--two"><NumberField label="Top Margin(px)" max="2000" value={printConfig.nablTopMargin} onChange={(value) => updateConfig('nablTopMargin', value)} /><NumberField label="Bottom Margin(px)" max="2000" value={printConfig.nablBottomMargin} onChange={(value) => updateConfig('nablBottomMargin', value)} /></div><div className="template-print-config-check-grid"><CheckboxRow label="Use Custom Top Margin?" checked={printConfig.useCustomTopNabl} onChange={(value) => updateConfig('useCustomTopNabl', value)} /><CheckboxRow label="Use Custom Bottom Margin?" checked={printConfig.useCustomBottomNabl} onChange={(value) => updateConfig('useCustomBottomNabl', value)} /></div>
        {configStatus ? <div className={`template-print-config-status ${configStatus.includes('saved') ? 'is-success' : 'is-error'}`}>{configStatus}</div> : null}<button type="button" className="template-print-config-save" onClick={saveConfig} disabled={savingConfig}>{savingConfig ? 'Saving' : 'Save Config'}</button>
      </div></aside> : null}
    </section>
  </main>;
}
