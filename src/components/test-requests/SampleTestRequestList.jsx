'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '../layout/PageHeader.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import DataTable from '../ui/DataTable.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { apiRequest } from '../../lib/api-client.js';
import AllocationModal from './AllocationModal.jsx';
import '../../styles/test-requests-listing-page.scss';

const states = { created: ['Not allocated', 'gray'], allocated: ['Under Testing', 'blue'], in_progress: ['Under Testing', 'blue'], under_review: ['Sent For Review', 'yellow'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'], cancelled: ['Cancelled', 'gray'] };
export default function SampleTestRequestList({ sampleId }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0); const [allocation, setAllocation] = useState(null);
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try { const result = await apiRequest(`/api/samples/${sampleId}/test-requests`, { signal: controller.signal }); if (!controller.signal.aborted) { setData(result); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [sampleId, reload]);
  if (!data) return error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading test requests..." />;
  const rows = data.rows.filter((row) => [row.requestNumber, row.productName, row.parameterName, row.methodName].some((value) => value.toLowerCase().includes(filter.toLowerCase())));
  return <>
    <PageHeader><section className="smplfy-tr-listing-header bg-white border-bottom"><div className="smplfy-tr-listing-header__title"><SecondaryButton size="medium" leftIcon="chevron-left" className="px-0 flex-shrink-0" aria-label="Back to sample" href={`/samples/${sampleId}`} /><h1 className="h5 mb-0 fw-semibold text-dark">Test Requests</h1></div><div className="smplfy-tr-listing-header__actions"><SecondaryButton size="medium" leftIcon="external-link" href={`/samples/${sampleId}`}>Go to Sample</SecondaryButton></div></section></PageHeader>
    <section className="smplfy-tr-listing-search bg-white border-bottom"><div className="container-fluid px-4"><div className="row h-100 align-items-center gx-3"><div className="col-xl-5 col-lg-6 col-12"><form className="input-group flex-nowrap" onSubmit={(event) => { event.preventDefault(); setFilter(search); }}><span className="input-group-text text-secondary"><AppIcon name="search" /></span><input className="smplfy-form-control form-control" aria-label="Search test requests" placeholder="Search in Test Requests" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="smplfy-btn btn btn-primary" type="submit" aria-label="Search test requests"><AppIcon name="chevron-right" /></button></form></div></div></div></section>
    <main className="smplfy-tr-listing-page bg-body-tertiary min-vh-100 d-flex flex-column gap-3">
      {error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
      <section className="smplfy-card smplfy-tr-requests-card card border-0"><div className="card-header bg-transparent d-flex align-items-center justify-content-between gap-3"><div className="fw-medium">{rows.length} Test Requests</div></div><div className="card-body"><DataTable>
        <thead><tr>{['Test Request ID', 'Status', 'Product', 'Parameter', 'MOA', 'Age', 'Target Reporting Date', 'Action'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td className="text-nowrap"><Link className="smplfy-link link-primary p-0" href={`/samples/${sampleId}/test_requests/${row.id}`}>{row.requestNumber}</Link></td><td className="text-nowrap"><StatusPill color={states[row.status]?.[1] ?? 'gray'}>{row.stateName || states[row.status]?.[0] || row.status}</StatusPill></td><td>{row.productName}</td><td>{row.parameterName}</td><td>{row.methodName}</td><td className="text-nowrap">{row.ageDays} days</td><td className="text-nowrap">{row.dueAt ? row.dueAt.slice(0, 10) : '—'}</td><td className="text-nowrap"><div className="d-flex align-items-center gap-2 flex-nowrap">{row.canAllocate ? <SecondaryButton leftIcon="user-plus" onClick={() => setAllocation(row)}>Allocate</SecondaryButton> : null}<SecondaryButton href={`/samples/${sampleId}/test_requests/${row.id}`}>View</SecondaryButton></div></td></tr>) : <tr><td colSpan={8}>No test requests found.</td></tr>}</tbody>
      </DataTable></div></section>
    </main>
    {allocation ? <AllocationModal request={allocation} onClose={() => setAllocation(null)} onAllocated={() => { setAllocation(null); setReload((value) => value + 1); }} /> : null}
  </>;
}
