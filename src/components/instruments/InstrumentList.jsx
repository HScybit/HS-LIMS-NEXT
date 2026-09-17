'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import Pagination from '../ui/Pagination.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import Modal from '../ui/Modal.jsx';
import Offcanvas from '../ui/Offcanvas.jsx';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { customFieldColumnKey, customFieldListDisplay } from '../../custom-fields/listing-values.js';
import InstrumentHealth from './InstrumentHealth.jsx';
import { instrumentCalendarDay } from '../../instruments/calendar.js';
import '../../styles/instruments-page.scss';

const columns = [['name', 'Name'], ['status', 'Status'], ['lab', 'Lab'], ['uid', 'UID'], ['serialNo', 'Serial no'], ['make', 'Make'],
  ['modelNo', 'Model'], ['lastServiceOn', 'Last Service on'], ['calibrated', 'Calibrated?'], ['nextServiceOn', 'Next Service on']];
const filterLabels = { status: 'Status', lab: 'Lab', calibrated: 'Calibrated', make: 'Make' };
function initialQuery(search) {
  try {
    const value = JSON.parse(search.get('query') || '{}');
    return { page: Number.isInteger(value?.page) && value.page > 0 && value.page <= 1_000_000 ? value.page : 1,
      pageSize: [10, 25, 50].includes(value?.pageSize) ? value.pageSize : 10, search: typeof value?.search === 'string' ? value.search.slice(0, 500) : '',
      filters: value?.filters && typeof value.filters === 'object' && !Array.isArray(value.filters)
        ? Object.fromEntries(Object.entries(value.filters).filter(([, item]) => typeof item === 'string').map(([key, item]) => [key, item.slice(0, 500)])) : {} };
  }
  catch { return { page: 1, pageSize: 10, search: '', filters: {} }; }
}
function FilterChoice({ kind, value, onChange }) {
  const [rows, setRows] = useState([]); const [error, setError] = useState(''); const [more, setMore] = useState(false); const controllers = useRef(new Set());
  const load = useCallback(search => {
    const controller = new AbortController(); controllers.current.add(controller);
    return apiRequest(`/api/instruments/filter-options?kind=${kind}&search=${encodeURIComponent(search)}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return [];
      setError(''); setMore(result.hasMore); if (!search) setRows(result.rows); return result.rows;
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); return []; }).finally(() => controllers.current.delete(controller));
  }, [kind]);
  useEffect(() => { void load(''); const active = controllers.current; return () => { for (const controller of active) controller.abort(); }; }, [load]);
  return <FormElement type="searchable-select" label={filterLabels[kind]} message={error} messageTone="error" helperText={more ? 'More choices match. Refine your search.' : undefined}
    inputProps={{ id: 'instrument-filter-' + kind, value, options: value ? [...rows, { value, label: value }] : rows, defaultOptions: rows, loadOptions: load, cacheOptions: false,
      menuPortalTarget: false, clearable: true, onChange, placeholder: 'Select ' + filterLabels[kind] }} />;
}

export default function InstrumentList({ canRead, canManage }) {
  const router = useRouter(); const searchParams = useSearchParams(); const [query, setQuery] = useState(() => initialQuery(searchParams));
  const [search, setSearch] = useState(query.search); const [data, setData] = useState(null); const [health, setHealth] = useState(null);
  const [reload, setReload] = useState(0); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [healthError, setHealthError] = useState('');
  const [draftFilters, setDraftFilters] = useState(null); const drawer = useRef(null);
  const [deletion, setDeletion] = useState(null); const [deleting, setDeleting] = useState(false); const [deleteError, setDeleteError] = useState('');
  const returnPath = '/equipments?query=' + encodeURIComponent(JSON.stringify(query));
  useEffect(() => {
    if (!canRead) return undefined;
    const controller = new AbortController();
    apiRequest('/api/instruments?query=' + encodeURIComponent(JSON.stringify({ ...query, asOfDate: instrumentCalendarDay() })), { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setData(result); setError(''); setLoading(false); }
    }).catch(failure => { if (!controller.signal.aborted) { setError(failure.message); setLoading(false); if ([401, 403].includes(failure.status)) setData(null); } });
    return () => controller.abort();
  }, [query, reload, canRead]);
  useEffect(() => {
    if (!canRead) return undefined;
    const controller = new AbortController();
    apiRequest('/api/instruments/overview?asOfDate=' + instrumentCalendarDay(), { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setHealth(result.health); setHealthError(''); } })
      .catch(failure => { if (!controller.signal.aborted) { setHealthError(failure.message); if ([401, 403].includes(failure.status)) setHealth(null); } });
    return () => controller.abort();
  }, [reload, canRead]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload(value => value + 1); };
    const timer = window.setInterval(refresh, 10_000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  function updateQuery(changes) { setLoading(true); setQuery(current => ({ ...current, ...changes })); }
  function removeFilter(key) { const next = { ...query.filters }; delete next[key]; updateQuery({ filters: next, page: 1 }); }
  async function remove() {
    if (deleting) return; setDeleting(true); setDeleteError('');
    try { await apiRequest(`/api/instruments/${deletion._id}`, { method: 'DELETE', body: { requestId: deletion.requestId, revision: deletion.revision } }); setDeletion(null); setReload(value => value + 1); }
    catch (failure) { setDeleteError(failure.message); } finally { setDeleting(false); }
  }
  if (!canRead) return <div className="alert alert-warning m-4" role="alert">Instrument module access is required.</div>;
  const listed = data?.fields.filter(field => field.showInList) ?? [];
  const filters = data?.fields.filter(field => field.showInFilter) ?? [];
  const labels = { ...filterLabels, ...Object.fromEntries(filters.map(field => [customFieldColumnKey(field), field.label])) };
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="h5 mb-0 fw-semibold text-dark">Instrument Management</h1></div>
      <div className="col-auto page-header__actions">{canManage ? <SecondaryButton leftIcon="plus" onClick={() => router.push('/equipments/new?from=' + encodeURIComponent(returnPath))}>New Instrument</SecondaryButton> : null}</div>
    </div></div></div></PageHeader>
    <main className="smplfy-instruments-page bg-body-tertiary p-4"><div className="container-fluid px-0">
      {error || healthError ? <div className="alert alert-danger" role="alert">{error || healthError}<button className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div> : null}
      {health ? <InstrumentHealth health={health} /> : null}
      <section className="d-flex flex-column gap-4 py-4"><div className="d-flex flex-column gap-2">
        <form className="row align-items-center gx-3 gy-2" onSubmit={event => { event.preventDefault(); updateQuery({ search, page: 1 }); }}>
          <div className="col-12 col-lg-5"><div className="input-group flex-nowrap bg-white border rounded overflow-hidden"><span className="input-group-text text-secondary bg-white"><AppIcon name="search" /></span>
            <input className="smplfy-form-control form-control" type="search" value={search} maxLength={500} placeholder="Search instruments" aria-label="Search instruments" onChange={event => setSearch(event.target.value)} />
            <button type="submit" className="smplfy-btn btn btn-primary" aria-label="Search instruments"><AppIcon name="chevron-right" /></button></div></div>
          <div className="col-auto"><button type="button" className="smplfy-btn btn btn-link text-secondary text-decoration-none border-0 bg-transparent shadow-none" onClick={() => setDraftFilters({ ...query.filters })}><AppIcon name="filter" /><span>All Filters</span></button></div>
        </form>
        <div className="d-flex flex-wrap gap-2">{Object.entries(query.filters).filter(([, value]) => value).map(([key, value]) => <div className="smplfy-badge badge text-secondary bg-white border d-inline-flex gap-2" key={key}>
          <span>{labels[key] ?? key}: {value}</span><button type="button" className="btn-close" aria-label={`Remove ${labels[key] ?? key} filter`} onClick={() => removeFilter(key)} /></div>)}</div>
      </div><div className="smplfy-instruments-count-label text-secondary fw-medium" role="status">{loading ? 'Loading instruments...' : `${data?.totalCount ?? 0} Instruments`}</div></section>
      <DataTable stickyActionColumn tableLayout="auto" aria-busy={loading}><thead><tr>{columns.map(([key, label]) => <th key={key} scope="col">{label}</th>)}{listed.map(field => <th key={field.id} scope="col">{field.label}</th>)}<th scope="col">Action</th></tr></thead>
        <tbody>{(data?.rows ?? []).map(row => <tr key={row._id}><td className="text-nowrap"><Link href={`/equipments/${row._id}?from=${encodeURIComponent(returnPath)}`}>{row.name}</Link></td>
          <td><span className={`smplfy-instrument-status-pill d-inline-flex align-items-center justify-content-center ${row.status === 'Breakdown' ? 'is-breakdown' : 'is-working'}`}><span className="smplfy-instrument-status-dot" aria-hidden="true" />{row.status}</span></td>
          {columns.slice(2).map(([key]) => <td className="text-nowrap" key={key}>{row[key] || '-'}</td>)}
          {listed.map(field => <td key={field.id} className="text-nowrap">{customFieldListDisplay(row.customFields?.[field.id], field) || '-'}</td>)}
          <td className="text-nowrap">{canManage ? <div className="d-flex gap-2 flex-nowrap"><SecondaryButton size="medium" leftIcon="edit" to={`/equipments/${row._id}/edit?from=${encodeURIComponent(returnPath)}`}>Edit</SecondaryButton>
            <SecondaryButton size="medium" tone="danger" leftIcon="trash" onClick={() => { setDeletion({ ...row, requestId: crypto.randomUUID() }); setDeleteError(''); }}>Delete</SecondaryButton></div> : '-'}</td></tr>)}
          {!data?.rows.length && !loading ? <tr><td colSpan={11 + listed.length} className="text-center text-secondary py-4">No instruments found.</td></tr> : null}
        </tbody></DataTable>
      {data ? <Pagination currentPage={data.page} pageSize={data.pageSize} totalItems={data.totalCount} pageSizeOptions={[10, 25, 50]} itemLabel="Instruments"
        onPageChange={page => updateQuery({ page })} onPageSizeChange={pageSize => updateQuery({ pageSize, page: 1 })} /> : null}
    </div></main>
    {draftFilters ? <Offcanvas ref={drawer} title="All Filters" className="smplfy-all-samples-offcanvas" onClose={() => setDraftFilters(null)}><div className="d-flex flex-column gap-3">
      {Object.keys(filterLabels).map(key => ['lab', 'make'].includes(key) ? <FilterChoice key={key} kind={key} value={draftFilters[key] ?? ''} onChange={value => setDraftFilters(current => ({ ...current, [key]: value }))} />
        : <FormElement key={key} type="dropdown" label={filterLabels[key]} inputProps={{ id: 'instrument-filter-' + key, value: draftFilters[key] ?? '', placeholder: 'Select ' + filterLabels[key],
          options: (key === 'status' ? ['Working', 'Breakdown'] : ['Yes', 'No']).map(value => ({ value, label: value })), onChange: event => setDraftFilters(current => ({ ...current, [key]: event.target.value })) }} />)}
      {filters.map(field => <FormElement key={field.id} type={field.fieldType === 'select' ? 'dropdown' : 'text'} label={field.label} inputProps={{ id: 'instrument-filter-' + field.id, value: draftFilters[customFieldColumnKey(field)] ?? '',
        options: field.options.map(option => ({ value: option.label, label: option.label })), maxLength: 500, placeholder: 'Select ' + field.label, onChange: event => setDraftFilters(current => ({ ...current, [customFieldColumnKey(field)]: event.target.value })) }} />)}
      <div className="d-flex justify-content-between gap-3 border-top pt-4"><SecondaryButton onClick={() => drawer.current?.hide()}>Cancel</SecondaryButton>
        <PrimaryButton onClick={() => drawer.current?.hide(() => { updateQuery({ filters: draftFilters, page: 1 }); setDraftFilters(null); })}>Apply</PrimaryButton></div>
    </div></Offcanvas> : null}
    <Modal open={Boolean(deletion)} title="Delete Instrument" onClose={() => { if (!deleting) setDeletion(null); }} actions={<><SecondaryButton disabled={deleting} onClick={() => setDeletion(null)}>Cancel</SecondaryButton>
      <PrimaryButton styleVariant="destructive" disabled={deleting} onClick={remove}>{deleting ? 'Deleting...' : 'Delete'}</PrimaryButton></>}>
      {deleteError ? <div className="alert alert-danger" role="alert">{deleteError}</div> : null}<p>Delete <strong>{deletion?.name}</strong>?</p>
    </Modal>
  </>;
}
