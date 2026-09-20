'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import ToastNotification from '../ui/ToastNotification.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { notifyCustomCssChanged } from './CustomCssInjector.jsx';
import './custom-css-management.scss';

function getCssHealth(css) {
  if (!css.trim()) return { label: 'Blank', tone: 'neutral' };
  if (/<\/?\s*(script|style)\b/i.test(css)) return { label: 'Blocked tag', tone: 'danger' };
  if ((css.match(/{/g) || []).length !== (css.match(/}/g) || []).length) return { label: 'Check braces', tone: 'warning' };
  return { label: 'Ready', tone: 'success' };
}
const formatDate = (value) => value ? new Date(value).toLocaleString() : 'Not saved';

export default function CustomCssManagement({ canManage }) {
  const [saved, setSaved] = useState(null); const [cssContent, setCssContent] = useState(''); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [reload, setReload] = useState(0); const [toast, setToast] = useState(null);
  const request = useRef(null); const toastTimer = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('/api/report-assets/custom-css', { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setSaved(value); setCssContent(value.cssContent); setError('');
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const metrics = useMemo(() => ({ lines: cssContent ? cssContent.split('\n').length : 1, rules: (cssContent.match(/{/g) || []).length, characters: cssContent.length }), [cssContent]);
  const health = getCssHealth(cssContent); const isDirty = Boolean(saved && cssContent !== saved.cssContent);

  async function save() {
    if (!canManage || !isDirty || saving || health.tone === 'danger') return;
    const body = { cssContent, revision: saved.revision }; const content = JSON.stringify(body);
    if (request.current?.content !== content) request.current = { content, id: crypto.randomUUID() };
    setSaving(true);
    try {
      const value = await apiRequest('/api/report-assets/custom-css', { method: 'PUT', body: { ...body, requestId: request.current.id } });
      setSaved(value); setCssContent(value.cssContent); setToast({ tone: 'success', message: 'Custom CSS saved.' }); request.current = null;
      notifyCustomCssChanged();
    } catch (failure) { setToast({ tone: 'error', message: failure.message }); }
    finally {
      setSaving(false); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 3500);
    }
  }
  if (!saved) return error ? <div className="alert alert-danger" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader />;
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start"><h1 className="page-title mb-0">Custom CSS</h1></div><div className="col-auto page-header__actions"><div className="custom-css-header-actions">
        <div className="custom-css-summary" aria-label="Custom CSS status"><span className={`custom-css-status custom-css-status--${health.tone}`}>{health.label}</span>
          <span className="custom-css-summary__metric">{metrics.lines} lines</span><span className="custom-css-summary__metric">{metrics.rules} rules</span>
          <span className="custom-css-summary__metric custom-css-summary__metric--characters">{metrics.characters} chars</span>
          <span className="custom-css-summary__metric custom-css-summary__metric--updated">Updated: {formatDate(saved.updatedAt)}</span></div>
        {canManage ? <div className="custom-css-actions"><SecondaryButton size="medium" leftIcon="refresh" disabled={!isDirty || saving} onClick={() => setCssContent(saved.cssContent)}>Reset</SecondaryButton>
          <PrimaryButton leftIcon="save" disabled={!isDirty || saving || health.tone === 'danger'} onClick={save}>{saving ? 'Saving' : 'Save'}</PrimaryButton></div> : null}
      </div></div>
    </div></div></div></PageHeader>
    <section className="custom-css-page">
      {toast ? <ToastNotification tone={toast.tone} message={toast.message} className="custom-css-page__toast" onClose={() => setToast(null)} /> : null}
      <section className="custom-css-panel custom-css-editor-panel"><div className="custom-css-panel__header"><div><h2>Editor</h2><p>{isDirty ? 'Unsaved changes' : 'Saved'}</p></div><span className="custom-css-panel__icon"><AppIcon name="edit" /></span></div>
        <textarea className="custom-css-code" value={cssContent} spellCheck="false" readOnly={!canManage || saving} onChange={(event) => setCssContent(event.target.value)} aria-label="Custom CSS editor" />
      </section>
    </section>
  </>;
}
