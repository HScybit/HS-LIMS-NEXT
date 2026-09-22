'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import { apiBlobRequest, apiRequest } from '../../lib/api-client.js';
import { bulkUploadCommand, downloadBulkWorkbook, stageBulkUpload } from './BulkUpload.jsx';
import '../../styles/data-transfer.scss';

const toneColor = tone => tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : 'info';
function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Port of the PERN Data Transfer page over the staged bulk-upload pipeline:
// imports download the sample workbook (header row plus one example row),
// upload the completed file and continue in the validation preview; exports
// pick fields from the organization-scoped listings and save XLSX or CSV.
export default function DataTransferPage({ canImport, canExport }) {
  const router = useRouter();
  const [mode, setMode] = useState(canImport ? 'import' : 'export');
  const [state, setState] = useState({ loading: true, entities: [], error: null });
  const [entityKey, setEntityKey] = useState('');
  const [file, setFile] = useState(null); const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(''); const [progress, setProgress] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [selectedFields, setSelectedFields] = useState([]); const [exportFormat, setExportFormat] = useState('xlsx');
  const pending = useRef(null); const mounted = useRef(true); const controller = useRef(null);

  useEffect(() => {
    mounted.current = true; const abort = new AbortController();
    apiRequest('/api/data-transfer/entities', { signal: abort.signal })
      .then(result => {
        const first = result.items.find(item => mode === 'import' ? item.importable : item.exportable) ?? result.items[0];
        setState({ loading: false, entities: result.items, error: null });
        setEntityKey(current => current || first?.key || '');
        setSelectedFields(first?.fields.map(field => field.key) ?? []);
      })
      .catch(error => { if (error.name !== 'AbortError') setState({ loading: false, entities: [], error }); });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entity = state.entities.find(item => item.key === entityKey);
  const choices = useMemo(() => state.entities.filter(item => mode === 'import' ? item.importable : item.exportable), [state.entities, mode]);

  function changeEntity(nextKey) {
    const next = state.entities.find(item => item.key === nextKey);
    setEntityKey(nextKey); setFile(null); setFileName(''); pending.current = null; setProgress(null); setUncertain(false);
    setSelectedFields(next?.fields.map(field => field.key) ?? []);
  }
  function changeMode(next) {
    setMode(next); setProgress(null);
    const available = state.entities.filter(item => next === 'import' ? item.importable : item.exportable);
    if (available.length && !available.some(item => item.key === entityKey)) changeEntity(available[0].key);
  }

  async function downloadSample() {
    if (busy || !entity) return; setBusy('sample'); setProgress(null);
    try { await downloadBulkWorkbook(`/api/master-bulk/sample?resource=${entity.key}`, `${entity.key}_import_template.xlsx`); }
    catch (error) { if (mounted.current) setProgress({ tone: 'danger', text: error.message }); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function upload(event) {
    event.preventDefault(); if (busy || !entity) return;
    if (!file) { setProgress({ tone: 'danger', text: 'Choose a CSV or XLSX file.' }); return; }
    if (!pending.current) pending.current = bulkUploadCommand(entity.key, file);
    setBusy('upload'); setProgress({ tone: 'info', text: 'Staging the spreadsheet for an organization-scoped validation preview…', percent: 20 });
    controller.current = new AbortController();
    try {
      const result = await stageBulkUpload(pending.current, controller.current.signal);
      pending.current = null;
      if (!mounted.current) return;
      setUncertain(false); setProgress({ tone: 'success', text: 'Rows are staged. Opening the validation preview…', percent: 100 });
      router.push(`/bulk_uploads/${result.id}?from=${encodeURIComponent('/data_transfer')}`);
    } catch (error) {
      if (!mounted.current) return;
      const unknown = !error.status || error.status >= 500;
      if (!unknown) pending.current = null;
      setUncertain(unknown);
      setProgress({ tone: 'danger', text: unknown ? 'The upload result could not be confirmed. Retry to check the same upload.' : error.message });
    } finally { if (mounted.current) setBusy(''); }
  }

  async function exportData() {
    if (busy || !entity || !selectedFields.length) return;
    setBusy('export'); setProgress({ tone: 'info', text: 'Preparing organization data…', percent: 25 });
    try {
      const blob = await apiBlobRequest('/api/data-transfer/export', { body: { resource: entity.key, fields: selectedFields, format: exportFormat } });
      if (!mounted.current) return;
      setProgress({ tone: 'info', text: 'Saving the spreadsheet…', percent: 75 });
      saveBlob(blob, `${entity.key}_export.${exportFormat}`);
      setProgress({ tone: 'success', text: `${entity.label} exported as ${exportFormat.toUpperCase()}.`, percent: 100 });
    } catch (error) { if (mounted.current) setProgress({ tone: 'danger', text: error.message }); }
    finally { if (mounted.current) setBusy(''); }
  }

  const header = <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
    <div className="col page-header__start"><h1 className="page-title mb-0">Data Transfer</h1></div>
    <div className="col-auto page-header__actions d-flex gap-2"><SecondaryButton leftIcon="clock" href="/bulk_uploads">Transfer History</SecondaryButton></div>
  </div></div></div></PageHeader>;

  if (state.loading) return <>{header}<main className="data-transfer-page"><div className="data-transfer-loading" role="status"><span className="spinner-border spinner-border-sm" /> Loading data transfer…</div></main></>;

  const message = progress ? <div className={`data-transfer-message alert alert-${toneColor(progress.tone)} mb-0`} role="status">
    {progress.percent != null ? <div className="progress mb-2" aria-label="Transfer progress"><div className="progress-bar" style={{ width: `${progress.percent}%` }}>{progress.percent}%</div></div> : null}{progress.text}</div> : null;
  const disabled = Boolean(busy) || uncertain;

  return <>{header}<main className="data-transfer-page">
    <section className="data-transfer-commandbar border rounded">
      <div className="data-transfer-commandbar__identity"><span className="data-transfer-icon"><AppIcon name="arrows-exchange" /></span><div><span className="data-transfer-eyebrow">Data exchange center</span><h2>Import and export organization data</h2><p>Validate, correct and process files without changing master data prematurely.</p></div></div>
      <div className="data-transfer-commandbar__actions"><div className="data-transfer-mode-tabs" role="group" aria-label="Transfer mode">
        {[{ value: 'import', label: 'Import', icon: 'upload', visible: canImport }, { value: 'export', label: 'Export', icon: 'download', visible: canExport }].filter(option => option.visible).map(option =>
          <button type="button" key={option.value} className={mode === option.value ? 'is-selected' : ''} disabled={Boolean(busy)} aria-pressed={mode === option.value} onClick={() => changeMode(option.value)}><AppIcon name={option.icon} />{option.label}</button>)}
      </div></div>
    </section>

    <section className="data-transfer-workspace border rounded">
      <header className="data-transfer-workspace__header"><div className="data-transfer-workspace__title"><span className="data-transfer-icon"><AppIcon name={mode === 'import' ? 'upload' : 'download'} /></span><div><span className="data-transfer-eyebrow">{mode} workspace</span><h2>{mode === 'import' ? 'Prepare a validated import' : 'Build an organization export'}</h2><p>{mode === 'import' ? 'Uploaded rows stay staged until you explicitly process valid records.' : 'Select only the fields you need; exports never change application data.'}</p></div></div><StatusPill color={mode === 'import' ? 'orange' : 'blue'}>{mode === 'import' ? 'Review before processing' : 'Read only'}</StatusPill></header>
      <div className="data-transfer-workspace__body">
        {state.error ? <div className="alert alert-danger mb-0" role="alert">{state.error.message}</div> : null}
        {!state.error && !choices.length ? <div className="alert alert-warning mb-0" role="alert">No data types are available to {mode}.</div> : null}
        {!state.error && choices.length ? <div className="data-transfer-workspace__content">
          <section className="data-transfer-entity-summary"><div className="data-transfer-entity-summary__header"><span className="data-transfer-entity-summary__icon"><AppIcon name="database" /></span><div className="data-transfer-type-field"><label className="form-label" htmlFor="data-transfer-entity">Data Type</label><select className="form-select" id="data-transfer-entity" value={entityKey} disabled={disabled} onChange={event => changeEntity(event.target.value)}>{choices.map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select></div><StatusPill color={mode === 'import' ? 'orange' : 'blue'}>{mode === 'import' ? (entity?.writeMode === 'upsert' ? 'Create or update' : 'Create only') : 'Organization scoped'}</StatusPill></div></section>

          {mode === 'import' && entity ? <section className="data-transfer-panel">
            <div className="data-transfer-panel__header"><div><span className="data-transfer-panel__step">Source file</span><h3>Choose a spreadsheet</h3><p>XLSX or CSV · one header row · up to {entity.limits.importRows.toLocaleString()} data rows, {entity.limits.columns} columns and 16 MiB.</p></div><SecondaryButton leftIcon="download" disabled={disabled} onClick={downloadSample}>{busy === 'sample' ? 'Preparing…' : 'Download Sample Excel'}</SecondaryButton></div>
            <form id="data-transfer-import" className="data-transfer-upload-zone" onSubmit={upload}><span className="data-transfer-upload-zone__icon"><AppIcon name="upload" /></span><div className="data-transfer-upload-zone__field"><label className="form-label" htmlFor="data-transfer-file">Select Excel or CSV File</label><input className="form-control" id="data-transfer-file" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={disabled} onChange={event => { const chosen = event.target.files?.[0] ?? null; setFile(chosen); setFileName(chosen?.name ?? ''); pending.current = null; setProgress(null); }} />{fileName ? <div className="form-text">{fileName}</div> : null}</div></form>
            <div className="data-transfer-mapping-heading"><div><span className="data-transfer-panel__step">Expected columns</span><h3>Keep the sample headers</h3></div><StatusPill color="green">{entity.columns.filter(column => column.required).length} required · {entity.columns.length} total</StatusPill></div>
            <div className="data-transfer-mapping-table table-responsive"><table className="smplfy-table table table-hover align-middle mb-0" aria-label="Expected columns"><thead><tr><th>Column header</th><th>Field</th><th>Example value</th><th>Status</th></tr></thead><tbody>
              {entity.columns.map(column => <tr key={column.header}><th><code className="data-transfer-field-key">{column.header}</code></th><td>{column.label}</td><td className="text-secondary text-break">{column.example || '—'}</td><td><StatusPill color={column.required ? 'orange' : 'gray'}>{column.required ? 'Required' : 'Optional'}</StatusPill></td></tr>)}
            </tbody></table></div>
            {message}
            <div className="data-transfer-action-bar"><div><AppIcon name="checklist" /><span><strong>Next: server-side validation</strong>Uploading stages this file without changing master data; review, fix and process it in the preview.</span></div><PrimaryButton leftIcon="upload" type="submit" form="data-transfer-import" disabled={Boolean(busy) || !file}>{busy === 'upload' ? 'Uploading…' : uncertain ? 'Retry upload' : 'Upload and validate'}</PrimaryButton></div>
          </section> : null}

          {mode === 'export' && entity ? <section className="data-transfer-panel">
            <div className="data-transfer-panel__header"><div><span className="data-transfer-panel__step">Workbook fields</span><h3>Choose export columns</h3><p>Spreadsheet headers use the listing labels; up to {entity.limits.exportRows[exportFormat].toLocaleString()} records per {exportFormat.toUpperCase()} export.</p></div><div className="data-transfer-panel__actions"><select className="form-select form-select-sm" aria-label="Export format" value={exportFormat} disabled={disabled} onChange={event => setExportFormat(event.target.value)}><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option></select><SecondaryButton size="small" disabled={disabled} onClick={() => setSelectedFields(entity.fields.map(field => field.key))}>Select all</SecondaryButton><SecondaryButton size="small" disabled={disabled} onClick={() => setSelectedFields([])}>Clear</SecondaryButton></div></div>
            <div className="data-transfer-field-grid">{entity.fields.map(field => { const checked = selectedFields.includes(field.key); return <label className={`data-transfer-export-field${checked ? ' is-selected' : ''}`} key={field.key}><Checkbox checked={checked} disabled={disabled} aria-label={`Export ${field.label}`} onChange={() => setSelectedFields(current => checked ? current.filter(key => key !== field.key) : [...current, field.key])} /><span className="data-transfer-export-field__copy"><strong>{field.label}</strong><code>{field.key}</code></span></label>; })}</div>
            {message}
            <div className="data-transfer-action-bar"><div><AppIcon name="fa-user-shield" /><span><strong>Organization-scoped export</strong>Only records in your current organization are included.</span></div><PrimaryButton leftIcon="download" disabled={disabled || !selectedFields.length} onClick={exportData}>{busy === 'export' ? 'Preparing export…' : `Export ${selectedFields.length} Fields`}</PrimaryButton></div>
          </section> : null}
        </div> : null}
      </div>
    </section>
  </main></>;
}
