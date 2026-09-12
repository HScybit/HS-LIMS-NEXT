'use client';

import { useRef, useState } from 'react';
import { WorkflowDetailsRail, WorkflowTransitionRequestModal } from '../ui/WorkflowRail.jsx';
import RequestDetailsModal, { ApprovalChecklist } from './RequestDetailsModal.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { resolveFinalResult } from '../../datasheets/final-result.js';

const dateTime = (value) => value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '-';
function presentation(label, color, stateType) {
  const colors = { primary: 'blue', success: 'green', danger: 'red', warning: 'yellow', info: 'blue', secondary: 'gray' };
  return { label, color: colors[color] ?? color ?? (stateType === 'final' ? 'green' : stateType === 'cancelled' ? 'red' : 'blue') };
}
function approvalView(approval) {
  if (!approval) return null;
  return { ...approval, title: `${approval.referenceNumber} - Request details`, closed: approval.status !== 'pending',
    requestor_id: approval.requestedById, requestor_name: approval.requestedByName, created_at: approval.requestedAt,
    requestedOn: dateTime(approval.requestedAt), remarks: approval.comments,
    sourcePresentation: presentation(approval.sourceStateName, approval.sourceColor, approval.sourceStateType),
    targetPresentation: presentation(approval.targetStateName, approval.targetColor, approval.targetStateType),
    approvalRows: approval.approvalRows.map((row) => ({ ...row, comments: row.comment || '-', decisionOn: dateTime(row.decisionOn),
      status: row.status.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()) })) };
}

// Source rail and request/response dialogs share the same commands for samples
// and test requests. For a test request, the capture and transition commit once.
export default function WorkflowPanel({ workflow, runtime, activity = [], currentState, ariaLabel, onChanged }) {
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [comments, setComments] = useState('');
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const approval = approvalView(workflow?.approvalRequest);
  const selected = workflow?.transitions.find((transition) => transition.id === selectedId);
  const transitions = workflow?.transitions ?? [];
  const activities = [...activity, ...(workflow?.activity ?? []).map((item) => ({ key: item.id, date: item.occurredAt,
    title: `${item.action === 'started' ? 'Workflow started' : item.action}: ${item.toStateName}`,
    detail: item.comment, user: item.actorName, tone: item.action === 'completed' ? 'success' : 'info' }))]
    .sort((left, right) => new Date(right.date) - new Date(left.date));
  async function perform(action) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await action(); onChanged(); }
    catch (failure) { setError(failure.message); }
    finally { running.current = false; setBusy(false); }
  }
  function openTransition() {
    if (workflow?.testRequestId && runtime && ['in_progress', 'rejected'].includes(runtime.datasheet.status)) {
      try { resolveFinalResult(runtime.model, runtime.capture.occurrences, runtime.capture.values); }
      catch (failure) { setError(failure.message); return; }
    }
    setSelectedId(transitions[0]?.id ?? ''); setComments(''); setChecks({}); setError(''); setTransitionOpen(true);
  }
  function sendTransition() {
    if (!selected) { setError('Select a state before sending the request.'); return; }
    if (selected.requireComment && !comments.trim()) { setError('Add a comment before sending this request.'); return; }
    const missing = selected.checklistItems.some((item) => item.isRequired && !checks[item.id]);
    if (missing) { setError('Complete all required checklist items.'); return; }
    void perform(async () => {
      const transition = { revision: workflow.revision, transitionId: selected.id, comment: comments,
        checklistItemIds: selected.checklistItems.filter((item) => checks[item.id]).map((item) => item.id) };
      const needsSubmission = runtime && ['in_progress', 'rejected'].includes(runtime.datasheet.status);
      if (needsSubmission) {
        await apiRequest(`/api/workflow-runs/${workflow.id}/datasheet-transitions`, { method: 'POST', body: {
          datasheetId: runtime.datasheet.id, datasheet: { revision: runtime.datasheet.revision, captureRevision: runtime.capture.revision }, transition,
        } });
      } else await apiRequest(`/api/workflow-runs/${workflow.id}/transitions`, { method: 'POST', body: transition });
      setTransitionOpen(false);
    });
  }
  function respond(action, comment, checklistItemIds) {
    if (action !== 'approve' || !approval?.assignmentId) return;
    void perform(async () => {
      await apiRequest(`/api/approval-assignments/${approval.assignmentId}/approve`, { method: 'POST', body: { comment, checklistItemIds } });
      setDetailsOpen(false);
    });
  }
  const maySubmit = !workflow?.testRequestId || runtime && (runtime.canExecute || ['under_review', 'approved'].includes(runtime.datasheet.status));
  return <>
    {!transitionOpen && !detailsOpen && error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
    <WorkflowDetailsRail ariaLabel={ariaLabel} approvalRequest={approval} canRespond={approval?.canRespond}
      activityItems={activities} submitting={busy} emptyActionLabel={transitions.length && maySubmit ? 'Request Approval' : undefined}
      emptyActionIcon="send" emptyActionDisabled={busy} onEmptyAction={openTransition}
      emptyActionMessage={`Current state: ${workflow?.state.name || currentState || '-'}`}
      onOpenDetails={approval ? () => { setError(''); setDetailsOpen(true); } : undefined} />
    <WorkflowTransitionRequestModal open={transitionOpen} comments={comments} commentsRequired={selected?.requireComment} currentState={workflow?.state.name || currentState || '-'}
      selectedState={selectedId} stateOptions={transitions.map((item) => ({ value: item.id, label: item.targetStateName }))} submitting={busy}
      onCancel={() => { if (!busy) setTransitionOpen(false); }} onCommentsChange={setComments}
      onStateChange={(id) => { setSelectedId(id); setChecks({}); setError(''); }} onSubmit={sendTransition}>
      <ApprovalChecklist items={selected?.checklistItems ?? []} checkedItems={checks} disabled={busy}
        onSelectAll={() => setChecks(Object.fromEntries(selected.checklistItems.map((item) => [item.id, true])))}
        onToggle={(id, checked) => setChecks((previous) => ({ ...previous, [id]: checked }))} />
      {error ? <div className="alert alert-danger mb-0" role="alert">{error}</div> : null}
    </WorkflowTransitionRequestModal>
    {detailsOpen && approval ? <RequestDetailsModal key={`${approval.id}:${approval.assignmentId}`} request={approval} canRespond={approval.canRespond}
      submitting={busy} error={error} onClose={() => { if (!busy) setDetailsOpen(false); }} onSubmit={respond} /> : null}
  </>;
}
