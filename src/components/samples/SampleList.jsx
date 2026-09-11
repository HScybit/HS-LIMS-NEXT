'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { IconClock, IconTestPipe2, IconUserExclamation, IconChecks, IconX } from '@tabler/icons-react';
import PageHeader from '../layout/PageHeader.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import Pagination from '../ui/Pagination.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { apiRequest } from '../../lib/api-client.js';
import '../../styles/all-samples-listing-page.scss';
import '../../styles/sample-card.scss';
import '../../styles/parameter-circles.scss';

const tabs = [['', 'All Samples'], ['quality_control', 'IQC Samples'], ['interlaboratory', 'ILC Samples'], ['proficiency', 'PT Samples'], ['amendment', 'Amendment Samples'], ['complaint', 'Complaint Samples']];
const parameterStates = {
  created: ['Not allocated', 'neutral-400', 'neutral-900', IconClock], allocated: ['Under Testing', 'blue-350', 'blue-600', IconTestPipe2],
  in_progress: ['Under Testing', 'blue-350', 'blue-600', IconTestPipe2], under_review: ['Sent For Review', 'yellow-250', 'yellow-800', IconUserExclamation],
  approved: ['Approved', 'green-600', 'neutral-100', IconChecks], rejected: ['Rejected', 'red-400', 'neutral-100', IconX], cancelled: ['Cancelled', 'neutral-400', 'neutral-900', IconX],
};
function ParameterCircles({ sample }) {
  const id = useId(); const [active, setActive] = useState(null);
  return <div className="parameter-circles flex-grow-1 w-100 mw-100 flex-nowrap overflow-visible">{sample.parameters.map((parameter, index) => {
    const [label, circle, icon, Icon] = parameterStates[parameter.status] ?? parameterStates.created;
    const props = { className: `parameter-circles__item ${active === index ? 'is-active' : ''}`, 'aria-label': `${parameter.name}, ${label}`,
      style: { '--parameter-circle-color': `var(--smplfy-primitive-${circle})`, '--parameter-icon-color': `var(--smplfy-primitive-${icon})` },
      onMouseEnter: () => setActive(index), onMouseLeave: () => setActive(null), onFocus: () => setActive(index), onBlur: () => setActive(null), 'aria-describedby': active === index ? `${id}-${index}` : undefined };
    const content = <><Icon size={16} stroke={1.8} className="parameter-circles__icon" aria-hidden="true" /><span id={`${id}-${index}`} className={`parameter-circles__tooltip ${active === index ? 'is-visible' : ''}`} role="tooltip"><span className="parameter-circles__tooltip-name">{parameter.name}</span><span className="parameter-circles__tooltip-status">{label}</span></span></>;
    return parameter.requestId ? <Link key={parameter.id} href={`/samples/${sample.id}/test_requests/${parameter.requestId}`} {...props}>{content}</Link> : <span key={parameter.id} tabIndex={0} {...props}>{content}</span>;
  })}</div>;
}
const dateLabel = (value) => value ? new Date(value).toLocaleDateString('en-GB') : '—';

export default function SampleList({ canCreate }) {
  const [query, setQuery] = useState({ page: 1, pageSize: 10, search: '', sampleType: '' }); const [search, setSearch] = useState('');
  const [result, setResult] = useState(null); const [error, setError] = useState(''); const [view, setView] = useState('card'); const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const data = await apiRequest(`/api/samples?${new URLSearchParams(query)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setResult({ ...data, query }); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [query, reload]);
  const current = result?.query === query ? result : null;
  const update = (changes) => setQuery((previous) => ({ ...previous, ...changes }));
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row"><div className="col page-header__start"><h1 className="page-title mb-0">All Samples</h1></div><div className="col-auto page-header__actions">{canCreate ? <PrimaryButton href="/samples/new" leftIcon="plus">New Sample</PrimaryButton> : null}</div></div></div></div></PageHeader>
    <section className="smplfy-all-samples-tabs bg-white border-bottom"><div className="container-fluid px-4"><div className="row gx-0 align-items-stretch flex-nowrap"><div className="col"><div className="nav nav-tabs flex-nowrap overflow-auto border-0">{tabs.map(([value, label]) => <button key={value} type="button" className={`smplfy-nav-link nav-link text-nowrap ${query.sampleType === value ? 'active' : ''}`} aria-current={query.sampleType === value ? 'page' : undefined} onClick={() => update({ sampleType: value, page: 1 })}>{label}</button>)}</div></div></div></div></section>
    <section className="smplfy-all-samples-search bg-white border-bottom"><div className="container-fluid px-4"><div className="row align-items-center gx-3"><div className="col-xl-5 col-lg-6 col-12"><form className="input-group flex-nowrap" onSubmit={(event) => { event.preventDefault(); update({ search, page: 1 }); }}>
      <span className="input-group-text text-secondary"><AppIcon name="search" /></span><input className="smplfy-form-control form-control" aria-label="Search samples" placeholder={`Search in ${tabs.find(([value]) => value === query.sampleType)?.[1]}`} maxLength={500} value={search} onChange={(event) => setSearch(event.target.value)} />
      <button className="smplfy-btn btn btn-primary" type="submit" aria-label="Search samples"><AppIcon name="chevron-right" /></button>
    </form></div></div></div></section>
    <main className="smplfy-all-samples-page bg-body-tertiary flex-grow-1"><div className="container-fluid px-4">
      {error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
      {!current ? !error ? <AppLoader message="Loading samples..." /> : null : <>
        <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap text-secondary fw-medium"><span>{current.totalCount} Total Sample{current.totalCount === 1 ? '' : 's'}</span>
          <div className="smplfy-btn-group smplfy-sample-view-toggle btn-group" role="group" aria-label="Sample list view">{[['card', 'Card view', 'cards'], ['table', 'Tabular view', 'table']].map(([value, label, icon]) => <button type="button" key={value} aria-label={label} aria-pressed={view === value} className={`smplfy-btn btn ${view === value ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setView(value)}><AppIcon name={icon} /></button>)}</div>
        </div>
        {!current.rows.length ? <div className="smplfy-card card"><div className="card-body d-flex align-items-center justify-content-center text-secondary fw-medium">No samples found for this view.</div></div>
          : view === 'table' ? <div className="table-responsive mt-3"><table className="smplfy-table table table-bordered align-middle"><thead><tr><th>Sample ID</th><th>Status</th><th>Customer Representative</th><th>Sample Category</th><th>Reporting Date</th><th>Parameters</th></tr></thead><tbody>{current.rows.map((sample) => <tr key={sample.id}><td><Link href={`/samples/${sample.id}`}>{sample.sampleNumber}</Link></td><td><StatusPill color={sample.stateColor || 'blue'}>{sample.stateName || sample.status}</StatusPill></td><td>{sample.customerName ?? '—'}</td><td>{sample.categoryName}</td><td>{dateLabel(sample.dueAt)}</td><td><ParameterCircles sample={sample} /></td></tr>)}</tbody></table></div>
            : <div className="d-flex flex-column">{current.rows.map((sample) => <article key={sample.id} className="smplfy-card card smplfy-sample-card overflow-hidden p-0">
              <div className="card-header bg-transparent d-flex align-items-center gap-2"><Link className="smplfy-link link-primary card-title mb-0 p-0" href={`/samples/${sample.id}`}>{sample.sampleNumber}</Link><StatusPill color={sample.stateColor || 'blue'}>{sample.stateName || sample.status}</StatusPill></div>
              <div className="card-body smplfy-sample-card__data-grid"><div className="row row-cols-2 row-cols-md-3 row-cols-xl-6 gx-2">{[['Customer Representative', sample.customerName], ['Reference', sample.sampleNumber], ['Request Mode', sample.modeOfReceipt], ['Created on', dateLabel(sample.registeredAt)], ['Reporting Date', dateLabel(sample.dueAt)], ['Sample Category', sample.categoryName]].map(([label, value]) => <div className="col" key={label}><dl className="mb-0"><dt>{label}</dt><dd className="mb-0 text-truncate" title={value ?? ''}>{value || '—'}</dd></dl></div>)}</div></div>
              <div className="card-footer bg-transparent d-flex align-items-center gap-2"><div className="text-secondary flex-shrink-0">Parameters:</div><ParameterCircles sample={sample} /><div className="text-secondary text-end flex-shrink-0">{sample.parameters.filter((parameter) => parameter.status === 'approved').length}/{sample.parameters.length} Approved</div></div>
            </article>)}</div>}
        <Pagination currentPage={query.page} pageSize={query.pageSize} totalItems={current.totalCount} itemLabel="samples" onPageChange={(page) => update({ page })} onPageSizeChange={(pageSize) => update({ page: 1, pageSize })} />
      </>}
    </div></main>
  </>;
}
