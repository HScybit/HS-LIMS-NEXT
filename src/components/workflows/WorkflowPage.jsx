'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import { useNavigationGuard } from '../layout/NavigationGuard.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import WorkflowCanvas from './WorkflowCanvas.jsx';
import WorkflowNodeDialog from './WorkflowNodeDialog.jsx';
import WorkflowConnectionDialog from './WorkflowConnectionDialog.jsx';
import { workflowConnectionsAtPorts } from '../../workflows/connection-form.js';
import { apiRequest } from '../../lib/api-client.js';

const idle = { busy: false, uncertain: false, saved: false, stale: false, error: null };
const definitionPath = (id, versionId) => `/api/workflows/${id}/definition${versionId == null ? '' : `?versionId=${encodeURIComponent(versionId)}`}`;

export default function WorkflowPage({ workflowId, canManage }) {
  const search = useSearchParams(); const versionId = search.get('versionId'); const router = useRouter(); const navigation = useNavigationGuard();
  const key = `${workflowId}:${versionId ?? ''}`;
  const [state, setState] = useState(null); const [reload, setReload] = useState(0);
  const [form, setForm] = useState(null); const [action, setAction] = useState(idle); const [moving, setMoving] = useState(false);
  const dirty = useRef(false); const busy = useRef(false); const command = useRef(null); const loaded = useRef(null);
  const dragging = useRef(false);
  const data = state?.key === key ? state.data : null; const error = state?.key === key ? state.error : '';
  const editable = canManage && data?.workflow.active && ['draft', 'published'].includes(data.version.status);
  const disabled = action.busy || action.uncertain || action.stale || Boolean(form);
  useEffect(() => {
    if (loaded.current?.key === key && loaded.current.reload === reload) return;
    const controller = new AbortController();
    apiRequest(definitionPath(workflowId, versionId), { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { loaded.current = { key, reload }; setState({ key, data }); } })
      .catch((failure) => { if (!controller.signal.aborted) setState({ key, error: failure.message }); });
    return () => controller.abort();
  }, [workflowId, versionId, key, reload]);
  useEffect(() => {
    const pending = () => busy.current || dragging.current || Boolean(command.current) || dirty.current;
    const prepareLeave = async (leave = async () => {}) => {
      if (busy.current || dragging.current) return false;
      if (pending() && !window.confirm(command.current ? 'A save may have completed. Leave without confirming its result?' : 'You have unsaved workflow changes. Leave without saving them?')) return false;
      await leave(); return true;
    };
    const unregister = navigation?.register({ hasPending: pending, prepareLeave });
    const beforeUnload = (event) => { if (pending()) { event.preventDefault(); event.returnValue = ''; } };
    function followLink(event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !pending()) return;
      const link = event.target.closest('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin || target.pathname === window.location.pathname && target.search === window.location.search) return;
      event.preventDefault(); event.stopPropagation();
      void prepareLeave(async () => router.push(`${target.pathname}${target.search}${target.hash}`));
    }
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', followLink, true);
    return () => { unregister?.(); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', followLink, true); };
  }, [navigation, router]);
  function showDefinition(current, selectedVersionId) {
    const nextKey = `${workflowId}:${selectedVersionId ?? ''}`;
    loaded.current = { key: nextKey, reload }; setState({ key: nextKey, data: current });
    if (versionId !== selectedVersionId) router.replace(`/workflow_management/${workflowId}${selectedVersionId ? `?versionId=${selectedVersionId}` : ''}`, { scroll: false });
  }
  function closeForm(unchanged = false) {
    if (busy.current || command.current) return;
    if (!unchanged && dirty.current && !window.confirm('Discard unsaved workflow changes?')) return;
    dirty.current = false; setForm(null); setAction((current) => current.stale ? current : idle);
  }
  async function execute(operation, input, elementId) {
    if (busy.current || action.stale) return 'failed';
    if (!command.current && !editable) {
      setAction({ ...idle, stale: true, error: { message: 'Workflow editing is no longer available. Reload the workflow to continue.' } });
      return 'failed';
    }
    if (!command.current) {
      if (!operation) return 'failed';
      command.current = { body: { requestId: crypto.randomUUID(), versionId: data.version.id, revision: data.version.revision,
        operation, ...(elementId ? { elementId } : {}), ...(input === undefined ? {} : { input }) } };
    }
    busy.current = true; setAction({ ...idle, busy: true, operation: command.current.body.operation });
    try {
      command.current.saved ??= await apiRequest(`/api/workflows/${workflowId}/commands`, { method: 'POST', body: command.current.body });
      const current = await apiRequest(definitionPath(workflowId, command.current.saved.versionId));
      showDefinition(current, command.current.saved.versionId);
      command.current = null; dirty.current = false; setForm(null); setAction(idle);
      return 'saved';
    } catch (failure) {
      const saved = Boolean(command.current?.saved); const uncertain = saved || !failure.status || failure.status >= 500;
      if (!uncertain) command.current = null;
      setAction({ busy: false, saved, uncertain, operation: command.current?.body.operation, stale: !uncertain && failure.status === 409,
        error: saved ? { message: `The change was saved, but the workflow could not be reloaded. ${failure.message}` } : failure });
      return uncertain ? 'pending' : 'failed';
    } finally { busy.current = false; }
  }
  async function reloadWorkflow() {
    if (busy.current || command.current) return;
    busy.current = true; setAction((value) => ({ ...value, busy: true }));
    try {
      const current = await apiRequest(definitionPath(workflowId)); showDefinition(current, null);
      dirty.current = false; setForm(null); setAction(idle);
    } catch (failure) { setAction((value) => ({ ...value, busy: false, error: failure })); }
    finally { busy.current = false; }
  }
  function editNode(node) { if (!disabled && !dragging.current) { dirty.current = false; setAction(idle); setForm({ type: 'node', node }); } }
  function deleteNode(node) {
    if (!disabled && !dragging.current && window.confirm('Delete this node and its connected connections?')) void execute('delete_state', undefined, node.id);
  }
  function editConnection(connection, ports) {
    if (disabled || dragging.current) return;
    dirty.current = false; setAction(idle); setForm({ type: 'connection', connection, ports });
  }
  function createConnection(ports) {
    if (disabled || dragging.current) return;
    const matches = workflowConnectionsAtPorts(data.transitions, ports);
    if (matches.length > 1) { setAction({ ...idle, error: { message: 'More than one connection uses these ports. Select the individual connection to edit it.' } }); return; }
    editConnection(matches[0] ?? null, ports);
  }
  function deleteConnection() {
    if (action.busy || action.uncertain || action.stale || !form?.connection) return;
    if (window.confirm('Delete this connection?')) void execute('delete_transition', undefined, form.connection.id);
  }
  return <>
    <PageHeader><div className="page-header page-header--workflow-editor"><div className="container-fluid h-100"><div className="row page-header__row h-100 align-items-center justify-content-between gx-0">
      <div className="col page-header__start"><div className="page-title-wrap">
        <SecondaryButton size="medium" className="page-header__back" aria-label="Back to workflows" title="Back to workflows" to="/workflow_management"><AppIcon name="chevron-left" /></SecondaryButton>
        <h1 className="page-title mb-0">{data?.workflow.name || 'Workflow Editor'}</h1>
      </div></div>
      {data ? <div className="col-auto"><div className="page-header__actions workflow-header-actions">
        <span className="workflow-pill">{data.states.length} nodes</span><span className="workflow-pill">{data.transitions.length} connections</span>
        <span className={`workflow-pill ${data.version.status === 'draft' ? 'workflow-pill--warning' : 'workflow-pill--success'}`}>{data.version.status === 'draft' ? 'Draft' : data.version.status === 'published' ? 'Published' : 'Retired'}</span>
        {editable ? <><SecondaryButton size="medium" leftIcon="plus" disabled={disabled || moving} onClick={() => editNode(null)}>Add Node</SecondaryButton>
          <PrimaryButton size="medium" leftIcon="save" disabled={disabled || moving || data.version.status !== 'draft'} onClick={() => execute('publish', { changeSummary: 'Workflow flow saved' })}>Save Flow</PrimaryButton></> : null}
      </div></div> : null}
    </div></div></div></PageHeader>
    {!form && action.error ? <div className="alert alert-danger m-4" role="alert">{action.error.message}
      {action.uncertain ? <button type="button" className="btn btn-link" disabled={action.busy} onClick={() => execute()}>{action.saved ? 'Retry Reload' : 'Retry Save'}</button> : null}
      {action.stale ? <button type="button" className="btn btn-link" disabled={action.busy} onClick={reloadWorkflow}>Reload workflow</button> : null}
    </div> : null}
    {error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div>
      : data ? <main className="workflow-page workflow-page--editor"><section className="workflow-editor-card"><WorkflowCanvas states={data.states} transitions={data.transitions}
        onEditNode={editable ? editNode : undefined} onDeleteNode={editable ? deleteNode : undefined}
        onEditConnection={editable ? editConnection : undefined} onCreateConnection={editable ? createConnection : undefined}
        onMoveNode={editable ? (id, position) => execute('patch_state', { canvasX: position.x, canvasY: position.y }, id) : undefined}
        onDragChange={(value) => { dragging.current = value; setMoving(value); }} moving={moving}
        modalOpen={Boolean(form)} disabled={!form && (action.busy || action.uncertain || action.stale)} /></section></main>
        : <p className="text-muted m-4" role="status">Loading workflow...</p>}
    {form?.type === 'node' && data ? <WorkflowNodeDialog key={form.node?.id ?? 'new'} node={form.node} states={data.states} action={action}
      onSave={(input) => execute(form.node ? 'patch_state' : 'create_state', input, form.node?.id)} onClose={closeForm}
      onReload={reloadWorkflow} onDirtyChange={(value) => { dirty.current = value; }} /> : null}
    {form?.type === 'connection' && data ? <WorkflowConnectionDialog key={form.connection?.id ?? 'new'} connection={form.connection} ports={form.ports}
      states={data.states} transitions={data.transitions} action={action}
      onSave={(input) => execute(form.connection ? 'patch_transition' : 'create_transition', input, form.connection?.id)}
      onDelete={form.connection ? deleteConnection : undefined} onClose={closeForm} onReload={reloadWorkflow}
      onDirtyChange={(value) => { dirty.current = value; }} /> : null}
  </>;
}
