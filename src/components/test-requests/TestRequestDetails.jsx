'use client';

import { useEffect, useRef, useState } from 'react';
import PageHeader from '../layout/PageHeader.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import WorkflowPanel from '../workflows/WorkflowPanel.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import TemplateCanvas from '../templates/TemplateCanvas.jsx';
import { apiBlobRequest, apiRequest } from '../../lib/api-client.js';
import { buildPreviewDocument } from '../templates/template-preview-document.js';
import { valueKey } from '../../templates/calculations.js';
import { MethodSwitcher, AddMethodModal, DeleteMethodModal } from './MethodControls.jsx';
import '../../styles/template-designer.scss';
import '../../styles/tr-details-page.scss';

const statuses = { created: ['Not allocated', 'gray'], allocated: ['Under Testing', 'blue'], in_progress: ['Under Testing', 'blue'],
  under_review: ['Send For Review', 'yellow'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'], cancelled: ['Cancelled', 'gray'] };

export default function TestRequestDetails({ requestId, sampleId, initialDatasheetId = '' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState(initialDatasheetId);
  const [methodModal, setMethodModal] = useState(null);
  const [methodToDelete, setMethodToDelete] = useState(null);
  const [methodDraft, setMethodDraft] = useState('');
  const [methodError, setMethodError] = useState('');
  const [methodBusy, setMethodBusy] = useState(false);
  const mutationRunning = useRef(false);
  const templateRoot = useRef(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const request = await apiRequest(`/api/test-requests/${requestId}?sampleId=${encodeURIComponent(sampleId)}`, { signal: controller.signal });
        const datasheetId = request.datasheets.some((sheet) => sheet.id === selectedId) ? selectedId : request.datasheetId;
        const [runtime, workflow] = await Promise.all([
          datasheetId ? apiRequest(`/api/datasheets/${datasheetId}?sampleId=${encodeURIComponent(sampleId)}`, { signal: controller.signal }) : null,
          request.workflowRunId ? apiRequest(`/api/workflow-runs/${request.workflowRunId}`, { signal: controller.signal }) : null,
        ]);
        if (!controller.signal.aborted) { setData({ request, runtime, workflow, selectedId, reload }); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load();
    return () => controller.abort();
  }, [requestId, sampleId, selectedId, reload]);
  async function changeMethod() {
    if (mutationRunning.current || !data || methodModal === 'delete' && !methodToDelete) return;
    mutationRunning.current = true; setMethodBusy(true); setMethodError('');
    try {
      if (methodModal === 'add') {
        const added = await apiRequest(`/api/test-requests/${requestId}/methods`, { method: 'POST', body: { revision: data.request.revision, methodId: methodDraft } });
        setSelectedId(added.datasheetId);
      } else {
        await apiRequest(`/api/test-requests/${requestId}/methods/${methodToDelete.id}`, { method: 'DELETE', body: { revision: data.request.revision } });
        setSelectedId('');
      }
      setMethodModal(null); setReload((value) => value + 1);
    } catch (failure) {
      setMethodError(failure.message);
      // Preserve the user's method choice while refreshing stale permissions
      // and revisions. A failed request never silently discards dialog input.
      if ([403, 404, 409].includes(failure.status)) setReload((value) => value + 1);
    } finally { mutationRunning.current = false; setMethodBusy(false); }
  }
  // The source Print action opens the rendered datasheet as a PDF in a new tab.
  async function printDatasheet() {
    if (!templateRoot.current || !data?.runtime || printing) return;
    const printWindow = window.open('', '_blank');
    setPrinting(true); setError('');
    try {
      const blob = await apiBlobRequest(`/api/datasheets/${data.runtime.datasheet.id}/print-pdf`, { body: {
        html: buildPreviewDocument(templateRoot.current, data.request.requestNumber), title: data.request.requestNumber, sampleId } });
      const url = URL.createObjectURL(blob);
      if (printWindow) printWindow.location.href = url; else window.open(url, '_blank');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (failure) {
      printWindow?.close(); setError(failure.message);
    } finally { setPrinting(false); }
  }
  if (!data) return error ? <div className="alert alert-danger m-3" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading test request..." />;
  const { request, runtime, workflow } = data;
  const created = new Date(request.createdAt);
  const status = statuses[request.status];
  const loading = data.selectedId !== selectedId || data.reload !== reload || request.id !== requestId;
  const methods = request.datasheets.map((sheet, index) => ({ ...sheet, label: `Method ${index + 1}` }));
  const selectedMethod = methods.find((method) => method.id === runtime?.datasheet.id);
  const canChangeMethods = !loading && request.canChangeMethods;
  const canDelete = canChangeMethods && methods.length > 1 && ['in_progress', 'rejected'].includes(selectedMethod?.status);
  const canDeleteTarget = canChangeMethods && methods.length > 1
    && methods.some((method) => method.id === methodToDelete?.id && ['in_progress', 'rejected'].includes(method.status));
  const closeMethodModal = () => { if (!methodBusy) setMethodModal(null); };
  return <>
    <PageHeader><section className="smplfy-tr-details-header"><div className="tr-details-page-header__title-wrap">
      <SecondaryButton size="medium" className="tr-details-page-header__back" aria-label="Go back" leftIcon="chevron-left" to={`/samples/${sampleId}/test_requests`} />
      <div className="tr-details-page-header__title-copy"><div className="tr-details-page-header__title-row"><h1>{request.requestNumber}</h1>
        <StatusPill color={status?.[1] ?? 'gray'}>{request.stateName || status?.[0] || request.status}</StatusPill>
      </div><div className="tr-details-page-header__timestamp"><span>{created.toLocaleDateString('en-GB')}</span><span>{created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div></div>
    </div><div className="tr-details-page-header__actions">
      {canChangeMethods ? <SecondaryButton leftIcon="plus" onClick={() => { setMethodDraft(''); setMethodError(''); setMethodModal('add'); }}>Add Method</SecondaryButton> : null}
      {!loading && runtime?.canExecute && request.canWork ? <SecondaryButton leftIcon="plus" to={`/samples/${sampleId}/data_sheets/${runtime.datasheet.id}`}>Add Results</SecondaryButton> : null}
      {!loading && runtime ? <PrimaryButton leftIcon="file-text" disabled={printing} onClick={printDatasheet}>{printing ? 'Preparing PDF...' : 'Print'}</PrimaryButton> : null}
    </div></section></PageHeader>
    <main className="smplfy-tr-details-page bg-body-tertiary min-vh-100"><div className="row g-3 align-items-stretch"><section className="col-12 col-xl min-w-0"><div className="tr-details-workspace">
      {error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
      {methods.length > 1 ? <MethodSwitcher methods={methods} selectedMethodId={selectedMethod?.id} canDeleteMethod={canDelete}
        onSelectMethod={setSelectedId} onDeleteMethod={() => { setMethodToDelete(selectedMethod); setMethodError(''); setMethodModal('delete'); }} /> : null}
      <section className="tr-details-page__content"><div className={`smplfy-card card smplfy-tr-details-content flex-fill ${runtime ? 'smplfy-tr-details-content--template' : 'align-items-center justify-content-center text-center text-secondary'}`}>
        {loading ? <AppLoader message="Loading method..." /> : runtime ? <div ref={templateRoot} className="tr-details-template"><TemplateCanvas model={runtime.model} mode="view" occurrences={runtime.capture.occurrences} dataContext={runtime.dataContext}
          values={Object.fromEntries(runtime.capture.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]))} validation={runtime.validation} /></div>
          : <div className="tr-details-page__placeholder">No methods have been added for this test request yet.</div>}
      </div></section>
    </div></section><div className="col-12 col-xl-auto smplfy-tr-details-rail"><WorkflowPanel ariaLabel="Test request workflow actions and activity"
      key={runtime?.datasheet.id} workflow={loading ? null : workflow} runtime={loading ? null : runtime}
      activity={request.methodActivity.map((item) => ({ key: item.id, date: item.occurredAt, user: item.actorName,
        title: `${item.action === 'datasheet_method_added' ? 'Added method' : 'Deleted method'}: ${item.methodName}`, detail: item.comment, tone: 'info' }))}
      currentState={request.stateName || status?.[0] || request.status} onChanged={() => setReload((value) => value + 1)} /></div>
    </div></main>
    <AddMethodModal open={methodModal === 'add'} requestId={request.requestNumber} draftValue={methodDraft} error={methodError}
      busy={methodBusy || loading} disabled={!canChangeMethods} methodOptions={request.applicableMethods.map((method) => ({ value: method.id, label: method.name }))}
      onDraftChange={setMethodDraft} onCancel={closeMethodModal} onSubmit={() => { if (!loading) void changeMethod(); }} />
    <DeleteMethodModal open={methodModal === 'delete'} method={methodToDelete} deleting={methodBusy || loading} disabled={!canDeleteTarget} error={methodError}
      onCancel={closeMethodModal} onSubmit={() => { if (!loading) void changeMethod(); }} />
  </>;
}
