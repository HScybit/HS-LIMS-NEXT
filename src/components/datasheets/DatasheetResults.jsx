'use client';

import { Profiler, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import { useNavigationGuard } from '../layout/NavigationGuard.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import TemplateCanvas from '../templates/TemplateCanvas.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { createCaptureAutosave } from '../../datasheets/autosave.js';
import { valueKey, capturedInputValue } from '../../templates/calculations.js';
import { resolveResultInput } from '../../templates/defaults.js';
import { showToast } from '../ui/toast.jsx';
import '../../styles/template-designer.scss';
import '../../styles/tr-details-page.scss';

const valueProperty = { numeric: 'numberValue', result: 'textValue', text: 'textValue', boolean: 'booleanValue', date: 'dateValue', option: 'optionId' };
const inputFor = (fieldId, occurrenceId, value) => ({ fieldId, occurrenceId, state: value === '' || value == null ? 'empty' : 'present', ...(value !== '' && value != null ? { value } : {}) });
const indexedValues = (values) => Object.fromEntries(values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]));
function draftValue(field, input) {
  return { fieldId: input.fieldId, occurrenceId: input.occurrenceId, valueType: field.valueType, state: input.state, origin: 'entered',
    ...(input.state === 'present' ? { [valueProperty[field.valueType]]: input.value } : {}) };
}

export default function DatasheetResults({ datasheetId, sampleId, requestedRevision }) {
  const router = useRouter();
  const navigationGuard = useNavigationGuard();
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [detailRequest, setDetailRequest] = useState(null);
  const [reload, setReload] = useState(0);
  const drafts = useRef(new Map());
  const operation = useRef(false);
  const current = useRef(null);
  const active = useRef(true);
  const applySaved = useCallback((result) => {
    if (!active.current || !current.current) return;
    const nextValues = indexedValues(result.values);
    for (const [key, input] of drafts.current) {
      const saved = nextValues[key];
      if (saved?.state === input.state && (capturedInputValue(saved) ?? null) === (input.value ?? null)) drafts.current.delete(key);
      else nextValues[key] = draftValue(current.current.model.fieldsById[input.fieldId], input);
    }
    const next = { ...current.current, validation: result.validation, capture: { ...current.current.capture, revision: result.revision, values: result.values } };
    if (result.parameterTitleValuesByRequestId && next.dataContext) {
      const results = next.dataContext.results.map((row) => {
        const { project_field_data: _customFields, ...base } = row.parameterTitleValues ?? {};
        return { ...row, parameterTitleValues: result.parameterTitleValuesByRequestId[row.testRequestId] ?? base };
      });
      next.dataContext = { ...next.dataContext, results, parametersByRequestId: Object.fromEntries(results.map((row) => [row.testRequestId, row])) };
    }
    current.current = next; setData(next); setValues(nextValues);
  }, []);
  // The queue constructor only stores callbacks; applySaved runs after an awaited save.
  // eslint-disable-next-line react-hooks/refs
  const [autosave] = useState(() => createCaptureAutosave((_instanceId, body) => apiRequest(`/api/datasheets/${datasheetId}/values`, { method: 'PATCH', body }), applySaved));

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    const query = new URLSearchParams({ sampleId, ...(requestedRevision ? { revision: requestedRevision } : {}) });
    performance.mark('datasheet:load-start');
    apiRequest(`/api/datasheets/${datasheetId}?${query}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      const start = performance.now();
      current.current = result; drafts.current.clear();
      autosave.reset(result.capture.instance.id, result.capture.revision, result.capture.values);
      setData(result); setValues(indexedValues(result.capture.values)); setError('');
      performance.measure('datasheet:state-enqueue', { start, end: performance.now() });
      performance.mark('datasheet:data-ready');
      performance.measure('datasheet:load', 'datasheet:load-start', 'datasheet:data-ready');
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => { active.current = false; controller.abort(); };
  }, [datasheetId, sampleId, requestedRevision, autosave, reload]);

  useLayoutEffect(() => {
    if (!data) return;
    const ready = performance.getEntriesByName('datasheet:data-ready', 'mark').at(-1);
    if (ready) performance.measure('datasheet:data-to-commit', { start: ready.startTime, end: performance.now() });
  }, [data]);

  const persistInput = useCallback(async (input, { force = false } = {}) => {
    const field = current.current?.model.fieldsById[input.fieldId];
    input = resolveResultInput(field, input);
    const key = valueKey(input.fieldId, input.occurrenceId);
    drafts.current.set(key, input);
    setValues((previous) => ({ ...previous, [key]: draftValue(field, input) }));
    const result = await autosave.commit(input, { force });
    if (result === false) {
      const pending = drafts.current.get(key);
      if (pending?.state === input.state && (pending.value ?? null) === (input.value ?? null)) drafts.current.delete(key);
    }
    return result;
  }, [autosave]);

  const flushPending = useCallback(async () => {
    await Promise.allSettled([...drafts.current.values()].map((input) => persistInput(input)));
    await autosave.flush();
  }, [autosave, persistInput]);

  const perform = useCallback(async (action, { retryDetail = false } = {}) => {
    if (operation.current) return false;
    if (detailRequest && !retryDetail) { setError('Retry the Parameter Detail refresh or reload before continuing.'); return false; }
    operation.current = true; setBusy(true); setError('');
    try { await flushPending(); await action(); return true; }
    catch (failure) { if (active.current) setError(failure.message); return false; }
    finally { operation.current = false; if (active.current) setBusy(false); }
  }, [flushPending, detailRequest]);

  useEffect(() => navigationGuard.register({
    hasPending: () => operation.current || Boolean(detailRequest) || drafts.current.size > 0 || (autosave.snapshot()?.pending.length ?? 0) > 0,
    prepareLeave: perform,
  }), [navigationGuard, autosave, perform, detailRequest]);

  useEffect(() => {
    const hasPending = () => Boolean(detailRequest) || drafts.current.size > 0 || (autosave.snapshot()?.pending.length ?? 0) > 0;
    function beforeUnload(event) {
      if (hasPending() || operation.current) { event.preventDefault(); event.returnValue = ''; }
    }
    function followLink(event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !hasPending()) return;
      const link = event.target.closest('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin || target.pathname === window.location.pathname && target.search === window.location.search) return;
      event.preventDefault(); event.stopPropagation();
      void perform(async () => router.push(`${target.pathname}${target.search}${target.hash}`));
    }
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', followLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', followLink, true); };
  }, [autosave, perform, router, detailRequest]);

  const change = useCallback((fieldId, occurrenceId, value) => {
    if (operation.current || !current.current?.canExecute) return;
    const input = inputFor(fieldId, occurrenceId, value); const key = valueKey(fieldId, occurrenceId);
    drafts.current.set(key, input);
    setValues((previous) => ({ ...previous, [key]: draftValue(current.current.model.fieldsById[fieldId], input) }));
  }, []);
  const beginEdit = useCallback((fieldId, occurrenceId) => {
    const key = valueKey(fieldId, occurrenceId); const prior = drafts.current.get(key);
    const instanceId = current.current?.capture.instance.id;
    return () => {
      if (!active.current || current.current?.capture.instance.id !== instanceId) return;
      if (prior) drafts.current.set(key, prior); else drafts.current.delete(key);
      const saved = current.current.capture.values.find((value) => valueKey(value.fieldId, value.occurrenceId) === key);
      const restored = prior ? draftValue(current.current.model.fieldsById[fieldId], prior) : saved;
      setValues((previous) => {
        const next = { ...previous };
        if (restored) next[key] = restored; else delete next[key];
        return next;
      });
    };
  }, []);
  const commit = useCallback((fieldId, occurrenceId, value) => {
    if (operation.current || !current.current?.canExecute) return;
    const input = inputFor(fieldId, occurrenceId, value);
    void persistInput(input, { force: current.current.model.fieldsById[fieldId].widget === 'result_widget' }).catch((failure) => { if (active.current) setError(failure.message); });
  }, [persistInput]);

  function done() {
    const selected = data.datasheet.attemptNumber > 1 ? `?datasheetId=${data.datasheet.id}` : '';
    void perform(async () => router.push(`/samples/${data.datasheet.sampleId}/test_requests/${data.datasheet.testRequestId}${selected}`));
  }
  function calculate() {
    void perform(async () => {
      setCalculating(true);
      const start = performance.now();
      try {
        const result = await apiRequest(`/api/datasheets/${datasheetId}/calculate`, { method: 'POST', body: { revision: autosave.snapshot().revision } });
        autosave.reset(result.instanceId, result.revision, result.values); applySaved(result);
        performance.measure('datasheet:calculate-save', { start, end: performance.now() });
      } finally { if (active.current) setCalculating(false); }
    });
  }
  const repeat = useCallback((command) => {
    if (command.type === 'remove' && !window.confirm('Are you sure you want to delete this row?')) return;
    void perform(async () => {
      const result = await apiRequest(`/api/datasheets/${datasheetId}/repeats`, { method: 'POST', body: { revision: autosave.snapshot().revision, command } });
      autosave.reset(result.instanceId, result.revision, result.values);
      current.current = { ...current.current, capture: { ...current.current.capture, occurrences: result.occurrences } };
      applySaved(result);
    });
  }, [applySaved, autosave, datasheetId, perform]);
  const refreshDetail = useCallback((fieldId, occurrenceId) => {
    void perform(async () => {
      const command = detailRequest ?? { revision: autosave.snapshot().revision, requestId: crypto.randomUUID(), fields: [{ fieldId, occurrenceId }] };
      setDetailRequest(command);
      try {
        const result = await apiRequest(`/api/datasheets/${datasheetId}/parameter-details`, { method: 'POST', body: command });
        autosave.reset(result.instanceId, result.revision, result.values); applySaved(result);
        if (active.current) { setDetailRequest(null); showToast('Parameter detail refreshed'); }
      } catch (failure) {
        if (active.current) {
          // A lost response may follow a committed refresh. Keep its exact
          // request until retry succeeds or an explicit reload reconciles it.
          if (failure.status >= 400 && failure.status < 500) setDetailRequest(null);
          showToast(failure.message, 'error');
        }
        throw failure;
      }
    }, { retryDetail: true });
  }, [applySaved, autosave, datasheetId, detailRequest, perform]);
  async function refresh() {
    if ((drafts.current.size || autosave.snapshot()?.pending.length) && !window.confirm('Reload and discard your unsaved changes?')) return;
    if (operation.current) return;
    operation.current = true; setBusy(true);
    // Wait for in-flight writes, then honor the explicit discard confirmation
    // even when the queue contains a stale-write or authorization failure.
    try { await autosave.flush(); } catch { /* Unsaved changes were explicitly discarded. */ }
    drafts.current.clear(); current.current = null; setDetailRequest(null);
    setData(null); setValues({}); setError(''); setReload((value) => value + 1);
    operation.current = false; setBusy(false);
  }

  if (!data) return error ? <div className="alert alert-danger m-3" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading datasheet..." />;
  return <>
    <PageHeader><section className="tr-details-page-header"><div className="tr-details-page-header__title-wrap">
      <SecondaryButton size="medium" leftIcon="chevron-left" className="tr-details-page-header__back" aria-label="Go back" disabled={busy} onClick={done} />
      <div className="tr-details-page-header__title-copy"><div className="tr-details-page-header__title-row"><h1>Add Results</h1></div>
        <div className="tr-details-page-header__timestamp"><span>{data.model.version.name || 'Datasheet'}</span></div></div>
    </div><div className="tr-details-page-header__actions">
      <SecondaryButton size="default" tone="primary" leftIcon="calculator" disabled={!data.canExecute || !data.model.calculationOrder.length || busy || Boolean(detailRequest)} onClick={calculate}>{calculating ? 'Calculating' : 'Calculate'}</SecondaryButton>
      <PrimaryButton leftIcon="check" disabled={busy || Boolean(detailRequest)} onClick={done}>Done</PrimaryButton>
    </div></section></PageHeader>
    <main className="tr-details-page tr-details-page--single-method tr-details-results-page" aria-busy={busy}>
      <section className="tr-details-page__content"><div className="tr-details-report-surface">
        {error ? <div className="alert alert-danger mb-3" role="alert">{error}
          {detailRequest ? <button type="button" className="btn btn-link" disabled={busy} onClick={() => refreshDetail()}>Retry refresh</button>
            : <button type="button" className="btn btn-link" disabled={busy} onClick={() => { void perform(async () => autosave.retry()); }}>Retry save</button>}
          <button type="button" className="btn btn-link" disabled={busy} onClick={refresh}>Reload</button>
        </div> : null}
        <div className="tr-details-template"><Profiler id="datasheet-canvas" onRender={(_id, phase, duration, _base, start) => performance.measure(`datasheet:react-${phase}`, { start, duration })}>
          <TemplateCanvas model={data.model} mode={data.canExecute ? 'edit' : 'view'} values={values} validation={data.validation} dataContext={data.dataContext}
            occurrences={data.capture.occurrences} onChange={change} onCommit={commit} onBeginEdit={beginEdit} onRepeat={repeat} onRefreshDetail={refreshDetail} busy={busy || Boolean(detailRequest)} />
        </Profiler></div>
      </div></section>
    </main>
  </>;
}
