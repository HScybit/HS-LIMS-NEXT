'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import PageHeader from '../layout/PageHeader.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import CardSelector from '../ui/CardSelector.jsx';
import ReportSelector from '../ui/ReportSelector.jsx';
import VersionSelector from '../ui/VersionSelector.jsx';
import InputFieldDropdown from '../ui/InputFieldDropdown.jsx';
import MoreActionButton from '../ui/MoreActionButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import ReportFrame from './ReportFrame.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { defaultPrintSettings } from '../../reports/input.js';
import { ParameterSelectionModal, PrintConfigModal } from './ReportModals.jsx';
import ReportPrintControl from './ReportPrintControl.jsx';
import '../../styles/coa-report-selection-page.scss';
import '../../styles/finalised-report-page.scss';
import '../../styles/template-designer.scss';

const reportTypes = [
  { key: 'consolidated', title: 'Consolidated', description: 'A single COA for all the parameters tested.' },
  { key: 'product_wise', title: 'Product Wise', description: 'Unique COA for each product.' },
  { key: 'parameter_wise', title: 'Parameter Wise', description: 'Unique COA for each parameter.' },
];

function TemplateRow({ label, value, options, disabled, onChange }) {
  return <div className="row g-2 align-items-center"><div className="col-lg-4 fw-medium text-body">{label}</div><div className="col-lg-8">
    <InputFieldDropdown aria-label={`${label} template`} value={value || ''} state={value ? 'filled' : 'default'} placeholder="Select Template" options={options} disabled={disabled} className="w-100" onChange={(event) => onChange(event.target.value)} />
  </div></div>;
}

export default function SampleCoa({ sampleId }) {
  const [options, setOptions] = useState(null); const [reports, setReports] = useState([]); const [reload, setReload] = useState(0);
  const [error, setError] = useState(''); const [previewError, setPreviewError] = useState('');
  const [readyPreview, setReadyPreview] = useState(null);
  const [selectedId, setSelectedId] = useState(''); const [preview, setPreview] = useState(null); const [expandedType, setExpandedType] = useState('consolidated');
  const [selecting, setSelecting] = useState(true); const [reportType, setReportType] = useState(''); const [templates, setTemplates] = useState({});
  const [selectedTestIds, setSelectedTestIds] = useState([]); const [printConfig, setPrintConfig] = useState(defaultPrintSettings);
  const [modal, setModal] = useState(null); const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); const attempt = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([apiRequest(`/api/samples/${sampleId}/report-options`, { signal: controller.signal }), apiRequest(`/api/samples/${sampleId}/reports`, { signal: controller.signal })])
      .then(([choices, history]) => {
        if (controller.signal.aborted) return;
        setOptions(choices); setReports(history.items); setError('');
        setSelectedTestIds(choices.products.flatMap((product) => product.tests.map((test) => test.id)));
        setTemplates(Object.fromEntries(['consolidated', ...choices.products.map((product) => product.id)].map((key) => [key, choices.defaultTemplateId || ''])));
        if (history.items.length) { setSelectedId(history.items[0].id); setExpandedType(history.items[0].reportType); setSelecting(false); }
      }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [sampleId, reload]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    apiRequest(`/api/reports/${selectedId}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) { setPreview(result); setPreviewError(''); }
    }).catch((failure) => { if (!controller.signal.aborted) setPreviewError(failure.message); });
    return () => controller.abort();
  }, [selectedId, reload]);
  const selectedReport = reports.find((report) => report.id === selectedId);
  const versions = useMemo(() => reports.filter((report) => report.groupKey === selectedReport?.groupKey).sort((left, right) => right.revision - left.revision), [reports, selectedReport?.groupKey]);
  const groups = useMemo(() => reportTypes.map((type) => {
    const latest = new Map();
    for (const report of reports.filter((report) => report.reportType === type.key)) {
      if (!latest.has(report.groupKey) || latest.get(report.groupKey).revision < report.revision) latest.set(report.groupKey, report);
    }
    return { ...type, rows: [...latest.values()] };
  }).filter((group) => group.rows.length), [reports]);
  const selectedSet = useMemo(() => new Set(selectedTestIds), [selectedTestIds]);
  const products = options?.products.filter((product) => product.tests.some((test) => selectedSet.has(test.id))) ?? [];
  const templateKeys = reportType === 'consolidated' ? ['consolidated'] : products.map((product) => product.id);
  const allTests = options?.products.flatMap((product) => product.tests) ?? [];
  const blocker = !options?.canGenerate ? 'You cannot generate reports for this sample.'
    : !allTests.length ? 'This sample has no tests to report.'
      : options.requireApprovedTestRequests && allTests.some((test) => !test.isApproved) ? 'Approve all test requests before generating reports.'
        : allTests.some((test) => selectedSet.has(test.id) && !test.hasSubmission) ? 'Every selected test needs a submitted result.' : '';
  const canGenerate = !blocker && reportType && selectedTestIds.length > 0 && templateKeys.every((key) => templates[key]);
  const activePreview = preview?.report.id === selectedId ? preview : null;

  async function generate(finalizeSample = false) {
    if (busyRef.current || !canGenerate) return;
    busyRef.current = true; setBusy(finalizeSample ? 'finalize' : 'generate'); setError('');
    const input = { revision: options.sample.revision, reportType, finalizeSample, selectedSampleTestIds: selectedTestIds,
      templateSelections: templateKeys.map((key) => ({ key, templateId: templates[key] })), printConfig };
    const content = JSON.stringify(input);
    if (attempt.current?.content !== content) attempt.current = { content, id: crypto.randomUUID() };
    try {
      const result = await apiRequest(`/api/samples/${sampleId}/reports`, { method: 'POST', body: { ...input, requestId: attempt.current.id } });
      setOptions((current) => ({ ...current, sample: { ...current.sample, ...result.sample } }));
      setReports((current) => [...result.items, ...current.filter((report) => !result.items.some((item) => item.id === report.id))]);
      setSelectedId(result.items[0].id); setExpandedType(reportType); setSelecting(false); setPreviewError(''); attempt.current = null;
    } catch (failure) { setError(failure.message); }
    finally { busyRef.current = false; setBusy(false); }
  }

  function selectReport(id) { setSelectedId(id); setPreviewError(''); }
  if (!options) return error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading sample reports..." />;
  const templateOptions = options.templates.map((template) => ({ value: template.id, label: template.name }));
  return <>
    <PageHeader>{selecting ? <section className="d-flex align-items-center justify-content-between gap-3 bg-white border-bottom flex-wrap px-4 py-3">
      <div className="d-flex align-items-center gap-3 min-w-0"><SecondaryButton size="medium" leftIcon="chevron-left" className="px-0" aria-label="Go back" href={`/samples/${sampleId}`} /><h1 className="h6 fw-semibold text-body mb-0">{options.sample.sampleNumber}</h1></div>
      <div className="d-flex align-items-center gap-3 flex-wrap">
        {reports.length ? <SecondaryButton onClick={() => setSelecting(false)} disabled={busy}>View Reports</SecondaryButton> : null}
        <SecondaryButton leftIcon="edit" onClick={() => setModal('parameters')} disabled={busy || !allTests.length}>Edit Parameters</SecondaryButton>
        <PrimaryButton leftIcon="file-text" onClick={() => generate(true)} disabled={Boolean(busy) || !canGenerate}>{busy === 'finalize' ? 'Finalising...' : 'Finalise'}</PrimaryButton>
        <SecondaryButton leftIcon="file-text" onClick={() => generate(false)} disabled={Boolean(busy) || !canGenerate}>{busy === 'generate' ? 'Generating...' : 'Generate'}</SecondaryButton>
        <MoreActionButton disabled={busy} items={[{ key: 'config', label: 'Print Configs', leftIcon: 'settings', onClick: () => setModal('print') }]} />
      </div>
    </section> : <section className="finalised-report-page-header"><div className="finalised-report-page-header__title-wrap">
      <SecondaryButton size="medium" className="finalised-report-page-header__back" leftIcon="chevron-left" aria-label="Go back" href={`/samples/${sampleId}`} />
      <h1>{selectedReport?.reportNumber || options.sample.sampleNumber}</h1>
      <VersionSelector value={selectedId} options={versions.map((report) => ({ value: report.id, label: `Version ${report.revision}` }))} disabled={versions.length < 2} onChange={selectReport} />
      {selectedReport ? <StatusPill color="blue">{selectedReport.status === 'draft' ? selectedReport.isFinalized ? 'Finalised' : 'Draft' : selectedReport.status}</StatusPill> : null}
    </div><div className="finalised-report-page-header__actions">
      {selectedId ? <ReportPrintControl key={selectedId} reportId={selectedId} disabled={!activePreview || readyPreview !== activePreview || Boolean(previewError)} onError={setError} /> : null}
      {options.canGenerate ? <MoreActionButton items={[{ key: 'regenerate', label: 'Regenerate', leftIcon: 'refresh', onClick: () => { setSelecting(true); setError(''); } }]} /> : null}
    </div></section>}</PageHeader>
    {error ? <div className="alert alert-danger m-3" role="alert">{error}</div> : null}
    {selecting ? <main className="smplfy-coa-report-page bg-body-tertiary p-3 p-md-4"><section className="container-xl smplfy-card card shadow-sm">
      <h2 className="h5 fw-semibold text-body mb-0">Select Report Type</h2><div className="row g-3 align-items-stretch">
        <div className="col-lg-4 d-flex flex-column gap-3">{reportTypes.map((type) => <CardSelector key={type.key} title={type.title} description={type.description} selected={reportType === type.key} className="w-100" disabled={busy} onClick={() => setReportType(type.key)} />)}</div>
        <div className="col-lg-8"><div className="smplfy-card card h-100">{reportType ? <>
          <div className="text-secondary">Select Templates</div>{blocker ? <div className="alert alert-warning py-2 mt-3 mb-0">{blocker}</div> : null}
          {!options.templates.length ? <div className="alert alert-warning py-2 mt-3 mb-0">No report templates are available.</div> : null}
          <div className="d-flex flex-column gap-3 mt-4">{reportType === 'consolidated'
            ? <TemplateRow label="Consolidated Report" value={templates.consolidated} options={templateOptions} disabled={busy} onChange={(value) => setTemplates((current) => ({ ...current, consolidated: value }))} />
            : products.map((product) => <TemplateRow key={product.id} label={product.name} value={templates[product.id]} options={templateOptions} disabled={busy} onChange={(value) => setTemplates((current) => ({ ...current, [product.id]: value }))} />)}</div>
        </> : <div className="d-flex flex-fill align-items-center justify-content-center text-secondary">Select a <span className="fw-semibold ms-1 me-1">Report type</span> to continue</div>}</div></div>
      </div></section></main> : <main className="finalised-report-page">
      <aside className="finalised-report-sidebar">{groups.map((group) => <section key={group.key} className={`finalised-report-group ${expandedType === group.key ? 'is-expanded' : ''}`}>
        <button type="button" className="finalised-report-group__header btn" aria-expanded={expandedType === group.key} onClick={() => setExpandedType((current) => current === group.key ? '' : group.key)}>
          <div><div className="finalised-report-group__title">{group.title}</div><div className="finalised-report-group__subtitle">Select a report to view</div></div><AppIcon name={expandedType === group.key ? 'chevron-up' : 'chevron-down'} />
        </button>{expandedType === group.key ? <div className="finalised-report-group__rows">{group.rows.map((report) => <ReportSelector key={report.id} label={report.reportNumber} hasNabl={false} state={selectedReport?.groupKey === report.groupKey ? 'active' : 'default'} onClick={() => selectReport(report.id)} />)}</div> : null}
      </section>)}</aside>
      <section className="finalised-report-preview">{previewError ? <div className="alert alert-danger" role="alert">{previewError}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div>
        : !activePreview ? <div className="finalised-report-preview__placeholder">Loading selected report...</div>
          : <div className="finalised-report-preview__scroll"><div className="finalised-report-preview__paper">
            <ReportFrame key={activePreview.report.id} report={activePreview} onReady={setReadyPreview} onError={setPreviewError} />
          </div></div>}</section>
    </main>}
    {modal === 'parameters' ? <ParameterSelectionModal products={options.products} selectedIds={selectedTestIds} onClose={() => setModal(null)} onSave={(ids) => { setSelectedTestIds(ids); setModal(null); }} /> : null}
    {modal === 'print' ? <PrintConfigModal config={printConfig} onClose={() => setModal(null)} onSave={(config) => { setPrintConfig(config); setModal(null); }} /> : null}
  </>;
}
