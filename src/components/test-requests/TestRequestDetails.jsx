'use client';

import { useEffect, useState } from 'react';
import PageHeader from '../layout/PageHeader.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import { WorkflowDetailsRail } from '../ui/WorkflowRail.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import TemplateCanvas from '../templates/TemplateCanvas.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { valueKey } from '../../templates/calculations.js';
import '../../styles/template-designer.scss';
import '../../styles/tr-details-page.scss';

const statuses = { created: ['Not allocated', 'gray'], allocated: ['Under Testing', 'blue'], in_progress: ['Under Testing', 'blue'],
  under_review: ['Send For Review', 'yellow'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'], cancelled: ['Cancelled', 'gray'] };

export default function TestRequestDetails({ requestId, sampleId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const request = await apiRequest(`/api/test-requests/${requestId}?sampleId=${encodeURIComponent(sampleId)}`, { signal: controller.signal });
        const runtime = request.datasheetId ? await apiRequest(`/api/datasheets/${request.datasheetId}?sampleId=${encodeURIComponent(sampleId)}`, { signal: controller.signal }) : null;
        if (!controller.signal.aborted) { setData({ request, runtime }); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load();
    return () => controller.abort();
  }, [requestId, sampleId, reload]);
  if (!data) return error ? <div className="alert alert-danger m-3" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading test request..." />;
  const { request, runtime } = data;
  const created = new Date(request.createdAt);
  const status = statuses[request.status];
  const activity = request.activity.map((item) => ({ key: item.id, date: item.occurredAt, title: `${item.action === 'started' ? 'Workflow started' : item.action}: ${item.stateName}`,
    detail: item.comment, user: item.actorName, tone: 'info' }));
  return <>
    <PageHeader><section className="smplfy-tr-details-header"><div className="tr-details-page-header__title-wrap">
      <SecondaryButton size="medium" className="tr-details-page-header__back" aria-label="Go back" leftIcon="chevron-left" to={`/samples/${sampleId}/test_requests`} />
      <div className="tr-details-page-header__title-copy"><div className="tr-details-page-header__title-row"><h1>{request.requestNumber}</h1>
        <StatusPill color={status?.[1] ?? 'gray'}>{request.stateName || status?.[0] || request.status}</StatusPill>
      </div><div className="tr-details-page-header__timestamp"><span>{created.toLocaleDateString('en-GB')}</span><span>{created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div></div>
    </div><div className="tr-details-page-header__actions">{runtime?.canExecute && request.canWork ? <SecondaryButton leftIcon="plus" to={`/samples/${sampleId}/data_sheets/${request.datasheetId}`}>Add Results</SecondaryButton> : null}</div></section></PageHeader>
    <main className="smplfy-tr-details-page bg-body-tertiary min-vh-100"><div className="row g-3 align-items-stretch"><section className="col-12 col-xl min-w-0"><div className="tr-details-workspace">
      <section className="tr-details-page__content"><div className={`smplfy-card card smplfy-tr-details-content flex-fill ${runtime ? 'smplfy-tr-details-content--template' : 'align-items-center justify-content-center text-center text-secondary'}`}>
        {runtime ? <div className="tr-details-template"><TemplateCanvas model={runtime.model} mode="view" occurrences={runtime.capture.occurrences}
          values={Object.fromEntries(runtime.capture.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]))} validation={runtime.validation} /></div>
          : <div className="tr-details-page__placeholder">No methods have been added for this test request yet.</div>}
      </div></section>
    </div></section><div className="col-12 col-xl-auto smplfy-tr-details-rail"><WorkflowDetailsRail ariaLabel="Test request workflow actions and activity"
      emptyActionMessage={`Current state: ${request.stateName || status?.[0] || request.status}`} activityItems={activity} activityEmptyMessage="No test request workflow activity recorded yet." /></div>
    </div></main>
  </>;
}
