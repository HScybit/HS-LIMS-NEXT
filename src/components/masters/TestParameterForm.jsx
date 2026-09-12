'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import ParameterUncertainty from './ParameterUncertainty.jsx';
import { emptyUncertaintyGrid, uncertaintySpreadsheet, updateUncertaintyGrid } from '../../masters/parameter-grid.js';
import { apiRequest } from '../../lib/api-client.js';

export const uncertaintyConfig = { label: 'Measurement Uncertainty', spreadsheetSettings: { headers: ['Sr. no.', 'Text'], isOrderedSequence: true } };

export default function TestParameterForm({ parameter }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: parameter?.name ?? '', description: parameter?.description ?? '', key: parameter?.key ?? '',
    schemeAbbreviation: parameter?.schemeAbbreviation ?? '', order: parameter?.order ?? '', laboratoryId: parameter?.laboratoryId ?? '' }));
  const [initialGrid] = useState(() => parameter?.measurementUncertainty ?? emptyUncertaintyGrid());
  const grid = useRef(initialGrid); const gridConfigured = useRef(Boolean(parameter?.measurementUncertainty)); const gridProblem = useRef('');
  const [gridError, setGridError] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({}); const [labError, setLabError] = useState(''); const [moreLabs, setMoreLabs] = useState(false);
  const [labOption, setLabOption] = useState(() => parameter?.laboratoryId ? { value: parameter.laboratoryId, label: parameter.laboratoryName } : null);
  const labQuery = useRef(null);
  const from = search.get('from'); const returnPath = from && /^\/test_parameters(?:\?[^#]*)?$/.test(from) ? from : '/test_parameters';
  useEffect(() => () => labQuery.current?.abort(), []);
  const loadLabs = useCallback(async (search) => {
    labQuery.current?.abort(); const controller = new AbortController(); labQuery.current = controller;
    try {
      const result = await apiRequest(`/api/masters/test-parameters/laboratories?search=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (controller.signal.aborted) return [];
      setLabError(''); setMoreLabs(result.hasMore);
      return result.rows.map((lab) => ({ value: lab.id, label: lab.name }));
    } catch (failure) {
      if (!controller.signal.aborted) { setLabError(failure.message); setMoreLabs(false); }
      return [];
    }
  }, []);
  function clearFieldError(field) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const { [field]: _error, ...rest } = current; return rest;
    });
  }
  const change = (field) => (event) => {
    const value = event.target.value; setDraft((current) => ({ ...current, [field]: value })); clearFieldError(field);
  };
  function changeGrid(_name, value) {
    gridConfigured.current = true;
    try { grid.current = updateUncertaintyGrid(grid.current, value); gridProblem.current = ''; }
    catch (failure) { gridProblem.current = failure.message; }
    // The editor keeps its raw draft. Invalid edits must never save the previous valid grid.
    setGridError(gridProblem.current);
  }
  async function save(event) {
    event.preventDefault(); if (saving || gridProblem.current) return;
    const problems = {};
    for (const [field, label] of [['name', 'Parameter Name'], ['key', 'Key'], ['schemeAbbreviation', 'Scheme Abbreviation']]) {
      if (!draft[field].trim()) problems[field] = `${label} is required.`;
    }
    for (const field of ['key', 'schemeAbbreviation']) {
      if (draft[field].trim() && !/^[A-Za-z0-9._/-]+$/.test(draft[field].trim())) problems[field] = 'Use letters, numbers, dots, underscores, slashes or hyphens.';
    }
    const order = draft.order === '' ? 0 : Number(draft.order);
    if (!Number.isSafeInteger(order) || order < 0 || order > 2_147_483_647) problems.order = 'Order must be an integer between 0 and 2147483647.';
    setFieldErrors(problems); if (Object.keys(problems).length) return;
    newId.current ??= crypto.randomUUID();
    const body = { ...draft, id: parameter?.id ?? newId.current, revision: parameter?.revision ?? 0, order,
      name: draft.name.trim(), key: draft.key.trim(), schemeAbbreviation: draft.schemeAbbreviation.trim(),
      laboratoryId: draft.laboratoryId || null, measurementUncertainty: gridConfigured.current ? grid.current : null };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/masters/test-parameters', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="mb-3"><FormElement label="Order" message={fieldErrors.order} messageTone="error"
        inputProps={{ type: 'number', name: 'order', placeholder: '1', min: 0, max: 2_147_483_647, step: 1, value: draft.order, onChange: change('order'), disabled: saving }} /></div>
      <div className="mb-3"><FormElement label="Parameter Name" mandatory message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Parameter Name', value: draft.name, onChange: change('name'), maxLength: 200, disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Description', value: draft.description, onChange: change('description'), maxLength: 16000, disabled: saving }} /></div>
      <div className="mb-3"><FormElement label="Key" mandatory message={fieldErrors.key} messageTone="error"
        inputProps={{ name: 'key', placeholder: 'PARA_998', value: draft.key, onChange: change('key'), maxLength: 64, disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="searchable-select" label="Lab Name" message={labError} messageTone="error"
        helperText={moreLabs ? 'More labs match. Refine your search to find a lab.' : undefined}
        inputProps={{ name: 'laboratoryId', placeholder: 'Select Lab', value: draft.laboratoryId, options: labOption ? [labOption] : [], loadOptions: loadLabs,
          cacheOptions: false, clearable: true, disabled: saving, noOptionsMessage: labError ? 'Labs could not be loaded. Try searching again.' : 'No options found',
          onChange: (value, option) => { setDraft((current) => ({ ...current, laboratoryId: value })); setLabOption(option); } }} /></div>
      <div className="mb-3"><FormElement label="Scheme Abbreviation" mandatory message={fieldErrors.schemeAbbreviation} messageTone="error"
        inputProps={{ name: 'schemeAbbreviation', placeholder: 'Ni', value: draft.schemeAbbreviation, onChange: change('schemeAbbreviation'), maxLength: 64, disabled: saving }} /></div>
      <ParameterUncertainty name="measurementUncertainty" cfg={uncertaintyConfig} value={uncertaintySpreadsheet(initialGrid)} error={gridError} disabled={saving} onChange={changeGrid}
        onInvalid={(message) => { gridProblem.current = message; setGridError(message); }} />
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving || Boolean(gridError)}>{saving ? 'Saving...' : parameter ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
