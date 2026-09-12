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
import JobSelectionControls from './JobSelectionControls.jsx';
import JobsCard from './JobsCard.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { showToast } from '../ui/toast.jsx';
import '../../styles/test-requests-listing-page.scss';

const states = { created: ['Not allocated', 'gray'], allocated: ['Under Testing', 'blue'], in_progress: ['Under Testing', 'blue'], under_review: ['Sent For Review', 'yellow'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'], cancelled: ['Cancelled', 'gray'] };
export default function SampleTestRequestList({ sampleId }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0); const [allocation, setAllocation] = useState(null);
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('');
  const [createJobMode, setCreateJobMode] = useState(false); const [selected, setSelected] = useState([]);
  const [assignee, setAssignee] = useState(''); const [reviewer, setReviewer] = useState(''); const [busy, setBusy] = useState(false);
  const [assigneeError, setAssigneeError] = useState(''); const [reviewerError, setReviewerError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try { const result = await apiRequest(`/api/samples/${sampleId}/test-requests`, { signal: controller.signal }); if (!controller.signal.aborted) { setData(result); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [sampleId, reload]);
  if (!data) return error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading test requests..." />;
  const filtered = data.rows.filter((row) => [row.requestNumber, row.productName, row.parameterName, row.methodName].some((value) => value.toLowerCase().includes(filter.toLowerCase())));
  const rows = filtered.filter((row) => !row.isJob && !row.parentRequestId); const jobs = filtered.filter((row) => row.isJob);
  const selectedRows = data.rows.filter((row) => selected.includes(row.id));
  const reviewerRequired = selectedRows.some((row) => !row.usesDynamicWorkflow);
  const selectableRows = rows.filter((row) => row.canJoinJob);
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selected.includes(row.id));
  function closeSelection() { setCreateJobMode(false); setSelected([]); setAssignee(''); setReviewer(''); setAssigneeError(''); setReviewerError(''); }
  async function createJobs() {
    if (busy) return;
    setAssigneeError(assignee ? '' : 'Select assignee.'); setReviewerError(reviewerRequired && !reviewer ? 'Select reviewer.' : '');
    if (!assignee || (reviewerRequired && !reviewer)) return;
    if (!selected.length || selected.length > 500) { setError('Select between 1 and 500 test requests.'); return; }
    if (selectedRows.length !== selected.length || selectedRows.some((row) => !row.canJoinJob)) { setError('The selected test requests changed. Select available unallocated requests.'); return; }
    setBusy(true); setError('');
    try {
      const result = await apiRequest('/api/test-requests/jobs', { method: 'POST', body: { requestIds: selected, analystUserId: assignee, reviewerUserId: reviewerRequired ? reviewer : null } });
      closeSelection(); setReload((value) => value + 1); showToast(`${result.items.length} job${result.items.length === 1 ? '' : 's'} created successfully.`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader><section className="smplfy-tr-listing-header bg-white border-bottom"><div className="smplfy-tr-listing-header__title"><SecondaryButton size="medium" leftIcon="chevron-left" className="px-0 flex-shrink-0" aria-label="Back to sample" href={`/samples/${sampleId}`} /><h1 className="h5 mb-0 fw-semibold text-dark">Test Requests</h1></div><div className="smplfy-tr-listing-header__actions"><SecondaryButton size="medium" leftIcon="external-link" href={`/samples/${sampleId}`}>Go to Sample</SecondaryButton></div></section></PageHeader>
    <section className="smplfy-tr-listing-search bg-white border-bottom"><div className="container-fluid px-4"><div className="row h-100 align-items-center gx-3"><div className="col-xl-5 col-lg-6 col-12"><form className="input-group flex-nowrap" onSubmit={(event) => { event.preventDefault(); setFilter(search); }}><span className="input-group-text text-secondary"><AppIcon name="search" /></span><input className="smplfy-form-control form-control" aria-label="Search test requests" placeholder="Search in Test Requests" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="smplfy-btn btn btn-primary" type="submit" aria-label="Search test requests"><AppIcon name="chevron-right" /></button></form></div></div></div></section>
    <main className="smplfy-tr-listing-page bg-body-tertiary min-vh-100 d-flex flex-column gap-3">
      {error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
      <section className={`smplfy-card smplfy-tr-requests-card ${createJobMode ? 'smplfy-tr-selection-card ' : ''}card border-0`}>
        {!createJobMode ? <div className="card-header bg-transparent d-flex align-items-center justify-content-between gap-3"><div className="fw-medium">{rows.length} Test Requests</div>
          {data.canCreateJobs && selectableRows.length ? <SecondaryButton leftIcon="plus" onClick={() => { setError(''); setCreateJobMode(true); }}>Create Job</SecondaryButton> : null}</div> : null}
        <div className="card-body">
          {createJobMode ? <JobSelectionControls users={data.users} assignee={assignee} reviewer={reviewer} reviewerRequired={reviewerRequired}
            assigneeError={assigneeError} reviewerError={reviewerError} busy={busy}
            onAssigneeChange={(value) => { setAssignee(value); setAssigneeError(''); }} onReviewerChange={(value) => { setReviewer(value); setReviewerError(''); }}
            onCancel={closeSelection} onSubmit={createJobs} /> : null}
          <DataTable>
        <thead><tr>{createJobMode ? <th scope="col" className="text-center"><Checkbox checked={allSelected} ariaLabel="Select all test requests" disabled={busy || !selectableRows.length}
          onChange={(checked) => setSelected((current) => checked ? [...new Set([...current, ...selectableRows.map((row) => row.id)])] : current.filter((id) => !selectableRows.some((row) => row.id === id)))} /></th> : null}
          {['Test Request ID', 'Status', 'Product', 'Parameter', 'MOA', 'Age', 'Target Reporting Date', ...(!createJobMode ? ['Action'] : [])].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.length ? rows.map((row) => <tr key={row.id}>
          {createJobMode ? <td className="text-center"><Checkbox checked={selected.includes(row.id)} ariaLabel={`Select ${row.requestNumber}`} disabled={busy || !row.canJoinJob}
            onChange={(checked) => setSelected((current) => checked ? [...new Set([...current, row.id])] : current.filter((id) => id !== row.id))} /></td> : null}
          <td className="text-nowrap"><Link className="smplfy-link link-primary p-0" href={`/samples/${sampleId}/test_requests/${row.id}`}>{row.requestNumber}</Link></td><td className="text-nowrap"><StatusPill color={states[row.status]?.[1] ?? 'gray'}>{row.stateName || states[row.status]?.[0] || row.status}</StatusPill></td><td>{row.productName}</td><td>{row.parameterName}</td><td>{row.methodName}</td><td className="text-nowrap">{row.ageDays} days</td><td className="text-nowrap">{row.dueAt ? row.dueAt.slice(0, 10) : '—'}</td>
          {!createJobMode ? <td className="text-nowrap"><div className="d-flex align-items-center gap-2 flex-nowrap">{row.canAllocate ? <SecondaryButton leftIcon="user-plus" onClick={() => setAllocation(row)}>Allocate</SecondaryButton> : null}<SecondaryButton href={`/samples/${sampleId}/test_requests/${row.id}`}>View</SecondaryButton></div></td> : null}
        </tr>) : <tr><td colSpan={8}>No test requests found.</td></tr>}</tbody>
      </DataTable></div></section>
      {jobs.length ? <JobsCard rows={jobs} sampleId={sampleId} states={states} onAllocate={setAllocation} /> : null}
    </main>
    {allocation ? <AllocationModal request={allocation} onClose={() => setAllocation(null)} onAllocated={() => { setAllocation(null); setReload((value) => value + 1); }} /> : null}
  </>;
}
