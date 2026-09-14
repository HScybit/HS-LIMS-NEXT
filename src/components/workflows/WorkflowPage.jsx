'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import WorkflowCanvas from './WorkflowCanvas.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function WorkflowPage({ workflowId }) {
  const search = useSearchParams(); const versionId = search.get('versionId');
  const key = `${workflowId}:${versionId ?? ''}`;
  const [state, setState] = useState(null); const [reload, setReload] = useState(0);
  const data = state?.key === key ? state.data : null; const error = state?.key === key ? state.error : '';
  useEffect(() => {
    const controller = new AbortController();
    apiRequest(`/api/workflows/${workflowId}/definition${versionId === null ? '' : `?versionId=${encodeURIComponent(versionId)}`}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setState({ key, data }); })
      .catch((failure) => { if (!controller.signal.aborted) setState({ key, error: failure.message }); });
    return () => controller.abort();
  }, [workflowId, versionId, key, reload]);
  return <>
    <PageHeader><div className="page-header page-header--workflow-editor"><div className="container-fluid h-100"><div className="row page-header__row h-100 align-items-center justify-content-between gx-0">
      <div className="col page-header__start"><div className="page-title-wrap">
        <SecondaryButton size="medium" className="page-header__back" aria-label="Back to workflows" title="Back to workflows" to="/workflow_management"><AppIcon name="chevron-left" /></SecondaryButton>
        <h1 className="page-title mb-0">{data?.workflow.name || 'Workflow Editor'}</h1>
      </div></div>
      {data ? <div className="col-auto"><div className="page-header__actions workflow-header-actions">
        <span className="workflow-pill">{data.states.length} nodes</span><span className="workflow-pill">{data.transitions.length} connections</span>
        <span className={`workflow-pill ${data.version.status === 'draft' ? 'workflow-pill--warning' : 'workflow-pill--success'}`}>{data.version.status === 'draft' ? 'Draft' : data.version.status === 'published' ? 'Published' : 'Retired'}</span>
      </div></div> : null}
    </div></div></div></PageHeader>
    {error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div>
      : data ? <main className="workflow-page workflow-page--editor"><section className="workflow-editor-card"><WorkflowCanvas states={data.states} transitions={data.transitions} /></section></main>
        : <p className="text-muted m-4" role="status">Loading workflow...</p>}
  </>;
}
