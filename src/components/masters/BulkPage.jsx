'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import DataTable from '../ui/DataTable.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { masterBulkChunkSize, masterBulkResources } from '../../masters/bulk-config.js';
import MasterBulkButton, { downloadBulkWorkbook } from './BulkUpload.jsx';
import '../../styles/bulk-upload.scss';

const cellText = value => value == null ? '' : String(value);
const operationLabel = { create: 'Create', update: 'Update existing record', reactivate: 'Reactivate and update', update_retired: 'Update retired record' };
const passwordStateLabel = { valid: 'Password saved', missing: 'Missing', invalid: 'Needs correction' };

function BulkHeader({ title, children }) {
  return <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
    <div className="col page-header__start"><h1 className="page-title mb-0">{title}</h1></div>
    <div className="col-auto page-header__actions d-flex gap-2">{children}</div>
  </div></div></div></PageHeader>;
}

export function BulkUploadList({ resources }) {
  const search = useSearchParams(); const router = useRouter(); const requested = search.get('resource');
  const resource = resources.includes(requested) ? requested : 'all';
  const [error, setError] = useState('');
  const returnPath = `/bulk_uploads${search.size ? `?${search}` : ''}`;
  const columns = useMemo(() => [
    { key: 'resource', header: 'Model', searchable: true, filterOptions: resources.map(value => ({ value, label: masterBulkResources[value].label })),
      format: value => masterBulkResources[value].label },
    { key: 'fileName', header: 'File Name', searchable: true },
    { key: 'savedAt', header: 'Uploaded On', type: 'date' },
    { key: 'status', header: 'Status', filterable: false, sortable: false, render: row => <>
      {row.committed === row.rowCount ? 'Completed' : row.rejected ? 'Needs fixes' : row.unvalidated ? 'Needs validation' : 'Ready'}
      <small className="d-block">{row.committed} of {row.rowCount} committed</small></> },
    { key: 'warnings', header: 'Warnings', filterable: false, sortable: false, render: row => <>{row.rejected} blocked / {row.updates} updates</> },
    { key: 'actions', header: 'Actions', render: row => <div className="d-flex flex-wrap gap-2">
      <Link className="btn btn-outline-secondary btn-sm" href={`/bulk_uploads/${row.id}?from=${encodeURIComponent(returnPath)}`}>Preview</Link>
      <SecondaryButton size="small" leftIcon="download" onClick={() => downloadBulkWorkbook(`/api/master-bulk/${row.id}/original`, `${row.resource}-original-rows.xlsx`).catch(failure => setError(failure.message))}>Original rows</SecondaryButton>
    </div> },
  ], [returnPath, resources]);
  const loadRows = useCallback(({ page, pageSize, search, filters, sort }) => apiRequest(`/api/master-bulk?resource=${resource}&query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`), [resource]);
  return <><BulkHeader title="Bulk Uploads"><MasterBulkButton key={resource} resource={resource === 'all' ? resources[0] : resource} resources={resources} /></BulkHeader>
    <section className="bulk-upload-page">
      <div className="bulk-upload-toolbar"><div className="bulk-upload-toolbar__copy"><h2>{masterBulkResources[resource]?.label ?? 'All models'}</h2><p>Uploaded spreadsheets and their processing results</p></div>
        <select aria-label="Filter model" className="form-select bulk-upload-toolbar__filters" value={resource} onChange={event => router.push(`/bulk_uploads?resource=${event.target.value}`)}>
          <option value="all">All models</option>
          {resources.map(value => <option key={value} value={value}>{masterBulkResources[value].label}</option>)}</select></div>
      {resources.includes('users') ? <p className="text-muted">User downloads have blank password cells. Reenter passwords before uploading a downloaded file.</p> : null}
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <DataTable key={resource} columns={columns} loadRows={loadRows} />
    </section></>;
}

export function BulkUploadPreview({ batchId }) {
  const search = useSearchParams();
  const from = search.get('from'); const returnPath = from === '/bulk_uploads' || from?.startsWith('/bulk_uploads?') ? from : null;
  const [data, setData] = useState(null); const [page, setPage] = useState(1); const [error, setError] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(''); const [retry, setRetry] = useState(false);
  const [editing, setEditing] = useState(null); const [fixes, setFixes] = useState({});
  const mounted = useRef(true); const running = useRef(false); const pending = useRef(null); const controller = useRef(null);
  const refresh = useCallback(async signal => {
    const result = await apiRequest(`/api/master-bulk/${batchId}?page=${page}&status=${blockedOnly ? 'rejected' : 'all'}`, { signal });
    if (mounted.current && !signal?.aborted) { setData(result); setError(''); }
    return result;
  }, [batchId, page, blockedOnly]);
  useEffect(() => {
    mounted.current = true; const read = new AbortController();
    refresh(read.signal).catch(failure => { if (!read.signal.aborted) setError(failure.message); });
    return () => { read.abort(); };
  }, [refresh]);
  useEffect(() => () => { mounted.current = false; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!editing && !retry && !busy) return;
    const beforeUnload = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editing, retry, busy]);
  async function execute(job) {
    if (running.current) return;
    running.current = true; pending.current = job; setBusy(true); setRetry(false); setError(''); controller.current = new AbortController();
    try {
      while (job.index < job.commands.length) {
        const command = job.commands[job.index];
        setProgress(`${job.label} ${job.index + 1} of ${job.commands.length}…`);
        await apiRequest(command.path, { method: command.method ?? 'POST', body: command.body, signal: controller.current.signal });
        job.index++;
      }
      if (mounted.current) {
        if (job.correction) { setEditing(null); setFixes({}); }
        await refresh(controller.current.signal); setProgress(`${job.label} complete.`);
      }
      pending.current = null;
    } catch (failure) {
      if (!mounted.current) return;
      const unknown = !failure.status || failure.status >= 500;
      if (!unknown) pending.current = null;
      setRetry(unknown); setError(unknown ? 'The last response could not be confirmed. Retry to resume the same requests safely.' : failure.message);
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  function run(action, rejectedOnly = false) {
    if (!data || running.current || pending.current) return;
    const rows = data.rowStates.filter(row => !row.committed && (!rejectedOnly || row.rejected) && (action === 'review' || row.valid && !row.rejected));
    const commands = [];
    for (let index = 0; index < rows.length; index += masterBulkChunkSize) commands.push({ path: `/api/master-bulk/${batchId}/${action}`,
      body: { rows: rows.slice(index, index + masterBulkChunkSize).map(row => ({ id: row.id, revision: row.revision, requestId: crypto.randomUUID(),
        ...(action === 'process' ? { reviewId: row.reviewId } : {}) })) } });
    if (commands.length) execute({ label: action === 'review' ? 'Validation' : 'Processing', commands, index: 0 });
  }
  function correct() {
    if (!editing || !Object.keys(fixes).length || running.current || pending.current) return;
    const correction = { id: editing.id, revision: editing.revision, requestId: crypto.randomUUID(), cells: Object.entries(fixes).map(([columnNumber, value]) => ({ columnNumber: Number(columnNumber), value })) };
    execute({ label: 'Saving fixes and validating', correction: true, index: 0, commands: [
      { path: `/api/master-bulk/${batchId}`, method: 'PATCH', body: correction },
      { path: `/api/master-bulk/${batchId}/review`, body: { rows: [{ id: editing.id, revision: editing.revision + 1, requestId: crypto.randomUUID() }] } },
    ] });
  }
  async function download() {
    if (running.current) return; running.current = true; setBusy(true); setError('');
    try { await downloadBulkWorkbook(`/api/master-bulk/${batchId}/rejected`, `${data.batch.resource}-rejected.xlsx`); }
    catch (failure) { if (mounted.current) setError(failure.message); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  const disabled = busy || retry || Boolean(editing);
  const config = data && masterBulkResources[data.batch.resource];
  const userUpload = data?.batch.resource === 'users';
  const customerUpload = data?.batch.resource === 'customers';
  const fixedColumns = userUpload || customerUpload;
  return <><BulkHeader title="Bulk Upload Preview"><SecondaryButton disabled={disabled} href={returnPath ?? `/bulk_uploads${data ? `?resource=${data.batch.resource}` : ''}`}>Uploads</SecondaryButton>
    <SecondaryButton disabled={disabled || !data || data.summary.committed === data.summary.total} onClick={() => run('review')}>Validate</SecondaryButton>
    <PrimaryButton disabled={disabled || !data?.summary.ready} onClick={() => run('process')}>Process valid rows</PrimaryButton></BulkHeader>
    <section className="bulk-upload-page bulk-upload-preview">
      {error ? <div className="alert alert-danger" role="alert">{error}{retry ? <button className="btn btn-link" disabled={busy} onClick={() => execute(pending.current)}>Retry interrupted action</button>
        : <button className="btn btn-link" disabled={busy} onClick={() => refresh().catch(failure => setError(failure.message))}>Reload</button>}</div> : null}
      {progress ? <div role="status" aria-live="polite">{progress}</div> : null}
      {data ? <><div className="bulk-upload-toolbar"><div className="bulk-upload-toolbar__copy"><h2>{config.label} Preview</h2><p>{data.batch.fileName} · {data.summary.total} data rows</p></div>
        <span className={`badge ${data.summary.committed === data.summary.total ? 'text-bg-success' : 'text-bg-secondary'}`}>{data.summary.committed === data.summary.total ? 'Completed' : 'In progress'}</span></div>
        <div className="bulk-upload-summary" aria-label="Bulk upload validation summary">
          <div className="bulk-upload-summary__item"><span>{data.summary.total}</span><small>Total rows</small></div>
          <div className="bulk-upload-summary__item"><span>{data.summary.rejected}</span><small>Cannot upload</small></div>
          <div className="bulk-upload-summary__item"><span>{data.summary.committed}</span><small>Committed</small></div></div>
        <div className="bulk-upload-validation-alert alert alert-info"><div>{data.summary.unvalidated ? `${data.summary.unvalidated} rows need validation.` : `${data.summary.ready} rows ready to process.${userUpload || customerUpload ? '' : ` ${data.summary.updates} matching records will be updated.`}`}</div>
          {userUpload ? <><div>User uploads create new accounts. Existing usernames and emails must be corrected before processing.</div>
            <div>Passwords are hidden. Leave a password untouched to keep it, enter a replacement, or use Clear password. Downloads have blank password cells; reenter passwords before uploading them again.</div></>
            : customerUpload ? <div>Customer uploads create new records. Existing names must be corrected before processing. Blank optional numeric fields use their defaults; supplied zero values are retained.</div>
              : <div>Omitted columns retain saved values. Supplied blank cells clear those fields. Each row shows whether it will create, update or reactivate a record.</div>}
          {data.batch.hasDateFields ? <div>New date values use {data.batch.timeZone}.{customerUpload ? '' : ' Rows with omitted saved dates retain that record’s date time zone.'}</div> : null}
          <Link href={config.path} className="btn btn-link p-0 mt-1">Open records</Link></div>
        {data.summary.rejected ? <div className="alert alert-warning d-flex flex-wrap justify-content-between gap-2"><span>{data.summary.rejected} rows need attention. Correct them below, then validate again.</span>
          <div className="d-flex gap-2"><SecondaryButton leftIcon="refresh" size="small" disabled={disabled} onClick={() => run('review', true)}>Retry rejected rows</SecondaryButton>
            <SecondaryButton leftIcon="download" size="small" disabled={disabled} onClick={download}>Download rejected rows</SecondaryButton></div></div> : null}
        {data.fileErrors.length ? <div className="bulk-upload-file-errors alert alert-danger"><strong>File errors</strong>
          <ul className="mb-0 mt-2">{data.fileErrors.map(message => <li key={message}>{message}</li>)}</ul></div> : null}
        <div className="bulk-upload-preview-panel"><div className="bulk-upload-table-actions"><div className="bulk-upload-table-actions__copy"><strong>Uploaded data</strong><span>Original file row numbers are shown. Committed rows cannot be changed.</span></div>
          <div className="bulk-upload-table-actions__controls">{editing ? <><SecondaryButton disabled={busy || retry} onClick={() => { setEditing(null); setFixes({}); }}>Discard fixes</SecondaryButton>
            <PrimaryButton disabled={busy || retry || !Object.keys(fixes).length} onClick={correct}>Save fixes &amp; revalidate</PrimaryButton></> : null}
            <SecondaryButton size="small" disabled={disabled || data.summary.unvalidated === data.summary.total} onClick={() => { setPage(1); setBlockedOnly(value => !value); }}>
              {blockedOnly ? 'Show All Rows' : 'Show Only Blocked Rows'}</SecondaryButton></div></div>
          <DataTable className={`bulk-upload-preview-table${fixedColumns ? ' bulk-upload-fixed-columns' : ''}`} style={fixedColumns ? { minWidth: 332 + 180 * data.batch.columnCount, tableLayout: 'fixed' } : undefined}>
            <thead><tr><th>Row</th><th>Validation</th>{data.batch.columns.map(column => <th key={column.columnNumber}>{column.header || '(blank)'}</th>)}</tr></thead>
            <tbody>{data.rows.map(row => { const blocked = !row.committed && (row.valid === false || row.processingCode); return <tr key={row.id}
              className={blocked ? 'bulk-upload-row--blocked' : row.valid && row.operation !== 'create' && !row.committed ? 'bulk-upload-row--warning' : ''}>
              <td>{row.rowNumber}</td><td className="bulk-upload-validation-cell">
                {!row.committed ? <SecondaryButton size="small" leftIcon="edit" className="bulk-upload-row-edit-toggle" disabled={disabled}
                  onClick={() => { setEditing(row); setFixes({}); setError(''); }}>Fix row {row.rowNumber}</SecondaryButton> : null}
                <div className="bulk-upload-validation-messages"><span>{row.committed ? `Committed · revision ${row.resultRevision}` : row.valid ? operationLabel[row.operation] : row.valid === false ? 'Cannot upload' : 'Not validated'}</span>
                  {blocked ? <span>{row.processingMessage || row.validationMessage}</span> : null}</div></td>
              {data.batch.columns.map(column => { const changed = editing?.id === row.id && Object.hasOwn(fixes, column.columnNumber); const value = changed ? fixes[column.columnNumber] : cellText(row.values[column.columnNumber - 1]);
                if (userUpload && column.header.trim() === 'password') return <td key={column.columnNumber} className={changed ? 'bulk-upload-cell--changed' : undefined}>
                  {editing?.id === row.id ? <><input type="password" autoComplete="new-password" className="form-control bulk-upload-cell-editor" maxLength={200}
                    aria-label={`Row ${row.rowNumber} password`} disabled={busy || retry} value={changed ? value : ''}
                    placeholder={row.passwordState === 'valid' ? 'Keep saved password' : 'Enter password'}
                    onChange={event => setFixes(current => ({ ...current, [column.columnNumber]: event.target.value }))} />
                    <small className="d-block mt-1">{changed ? value.trim() ? 'Replacement entered' : 'Password will be cleared' : passwordStateLabel[row.passwordState]}</small>
                    <button type="button" className="btn btn-link btn-sm px-0" disabled={busy || retry}
                      onClick={() => setFixes(current => ({ ...current, [column.columnNumber]: '' }))}>Clear password</button></>
                    : <span>{passwordStateLabel[row.passwordState]}</span>}</td>;
                return <td key={column.columnNumber} className={changed ? 'bulk-upload-cell--changed' : undefined}>{editing?.id === row.id
                  ? <textarea className="form-control bulk-upload-cell-editor" aria-label={`Row ${row.rowNumber} ${column.header || `column ${column.columnNumber}`}`} rows={2} maxLength={16000}
                    disabled={busy || retry} value={value} onChange={event => setFixes(current => ({ ...current, [column.columnNumber]: event.target.value }))} />
                  : <span>{value || '—'}</span>}</td>; })}</tr>; })}
              {!data.rows.length ? <tr><td colSpan={data.batch.columnCount + 2}>No blocked rows.</td></tr> : null}</tbody></DataTable>
          <div className="d-flex justify-content-end align-items-center gap-2 mt-3"><SecondaryButton disabled={disabled || data.page === 1} onClick={() => setPage(data.page - 1)}>Previous</SecondaryButton>
            <span>Page {data.page} of {Math.max(1, Math.ceil(data.filteredTotal / data.pageSize))}</span><SecondaryButton disabled={disabled || data.page * data.pageSize >= data.filteredTotal} onClick={() => setPage(data.page + 1)}>Next</SecondaryButton></div>
        </div></> : !error ? <div role="status">Loading upload…</div> : null}
    </section></>;
}
