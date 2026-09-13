'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import ParameterUncertainty from './ParameterUncertainty.jsx';
import { emptyUncertaintyGrid, uncertaintySpreadsheet, updateUncertaintyGrid } from '../../masters/parameter-grid.js';
import { apiRequest } from '../../lib/api-client.js';
import MasterCustomFields from './MasterCustomFields.jsx';
import { customFieldInitialValue, customFieldSubmittedValue, customFieldValidationError, customFieldNeedsGeneration } from '../../custom-fields/form-values.js';

const emptyFields = [];

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
  const [customFields, setCustomFields] = useState([]); const [customValues, setCustomValues] = useState({});
  const [customLoading, setCustomLoading] = useState(true); const [customLoadError, setCustomLoadError] = useState('');
  const [customReload, setCustomReload] = useState(0);
  const [uploadingFields, setUploadingFields] = useState(() => new Set()); const [generatingId, setGeneratingId] = useState('');
  const blocked = saving || Boolean(generatingId) || uploadingFields.size > 0;
  const storedFields = parameter?.customFields ?? emptyFields;

  const from = search.get('from'); const returnPath = from && /^\/test_parameters(?:\?[^#]*)?$/.test(from) ? from : '/test_parameters';
  useEffect(() => () => labQuery.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); const storedById = new Map(storedFields.map((field) => [field.fieldId, field]));
    apiRequest('/api/masters/test-parameters/custom-fields', { signal: controller.signal }).then(({ fields }) => {
      if (controller.signal.aborted) return;
      setCustomFields(fields); setCustomValues((current) => Object.fromEntries(fields.map((field) =>
        [field.id, Object.hasOwn(current, field.id) ? current[field.id] : customFieldInitialValue(field, storedById.get(field.id))])));
      setCustomLoadError(''); setCustomLoading(false);
    }).catch((failure) => { if (!controller.signal.aborted) { setCustomLoadError(failure.message); setCustomLoading(false); } });
    return () => controller.abort();
  }, [storedFields, customReload]);
  const onUploadBusy = useCallback((fieldId, busy) => setUploadingFields((current) => {
    const next = new Set(current); if (busy) next.add(fieldId); else next.delete(fieldId); return next;
  }), []);
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
  function changeCustomField(fieldId, value) {
    setCustomValues((current) => ({ ...current, [fieldId]: value })); clearFieldError(fieldId);
  }
  function capture(values) {
    if (!customFields.length) return {};
    return { customFields: customFields.map((field) => ({ fieldId: field.id, fieldRevision: field.revision, value: customFieldSubmittedValue(values[field.id]) })),
      ...(customFields.some((field) => ['date', 'date_time'].includes(field.fieldType))
        ? { customFieldTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}) };
  }
  async function generate(values, fieldId) {
    if (!fieldId && !customFields.some((field) => customFieldNeedsGeneration(field, parameter ? 'edit' : 'create', values[field.id]))) return values;
    const result = await apiRequest('/api/masters/test-parameters/custom-field-generation', { method: 'POST', body: {
      parameterId: parameter?.id ?? null, parameter: { ...draft, measurementUncertainty: gridConfigured.current ? grid.current : null }, ...capture(values), fieldId: fieldId ?? null,
    } });
    const next = { ...values };
    for (const item of result.values) next[item.fieldId] = item.value;
    setCustomValues(next); return next;
  }
  async function generateField(field) {
    if (blocked || customLoading || customLoadError) return;
    setGeneratingId(field.id); setError('');
    try { await generate(customValues, field.id); clearFieldError(field.id); }
    catch (failure) { setError(failure.message); }
    finally { setGeneratingId(''); }
  }
  function changeGrid(_name, value) {
    gridConfigured.current = true;
    try { grid.current = updateUncertaintyGrid(grid.current, value); gridProblem.current = ''; }
    catch (failure) { gridProblem.current = failure.message; }
    // The editor keeps its raw draft. Invalid edits must never save the previous valid grid.
    setGridError(gridProblem.current);
  }
  function saveBody(values) {
    return { ...draft, ...capture(values), id: parameter?.id ?? newId.current, revision: parameter?.revision ?? 0, order: draft.order === '' ? 0 : Number(draft.order),
      name: draft.name.trim(), key: draft.key.trim(), schemeAbbreviation: draft.schemeAbbreviation.trim(),
      laboratoryId: draft.laboratoryId || null, measurementUncertainty: gridConfigured.current ? grid.current : null };
  }
  async function save(event) {
    event.preventDefault(); if (blocked || customLoading || customLoadError || gridProblem.current) return;
    setSaving(true); setError('');
    let values;
    const replay = saveRequest.current?.content === JSON.stringify(saveBody(customValues));
    try { values = replay ? customValues : await generate(customValues); }
    catch (failure) { setError(failure.message); setSaving(false); return; }
    const problems = {};
    for (const [field, label] of [['name', 'Parameter Name'], ['key', 'Key'], ['schemeAbbreviation', 'Scheme Abbreviation']]) {
      if (!draft[field].trim()) problems[field] = `${label} is required.`;
    }
    for (const field of ['key', 'schemeAbbreviation']) {
      if (draft[field].trim() && !/^[A-Za-z0-9._/-]+$/.test(draft[field].trim())) problems[field] = 'Use letters, numbers, dots, underscores, slashes or hyphens.';
    }
    const order = draft.order === '' ? 0 : Number(draft.order);
    if (!Number.isSafeInteger(order) || order < 0 || order > 2_147_483_647) problems.order = 'Order must be an integer between 0 and 2147483647.';
    for (const field of customFields) {
      const problem = customFieldValidationError(field, values[field.id]); if (problem) problems[field.id] = problem;
    }
    setFieldErrors(problems); if (Object.keys(problems).length) { setSaving(false); return; }
    newId.current ??= crypto.randomUUID();
    const body = saveBody(values);
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    try {
      await apiRequest('/api/masters/test-parameters', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="mb-3"><FormElement label="Order" message={fieldErrors.order} messageTone="error"
        inputProps={{ type: 'number', name: 'order', placeholder: '1', min: 0, max: 2_147_483_647, step: 1, value: draft.order, onChange: change('order'), disabled: blocked }} /></div>
      <div className="mb-3"><FormElement label="Parameter Name" mandatory message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Parameter Name', value: draft.name, onChange: change('name'), maxLength: 200, disabled: blocked }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Description', value: draft.description, onChange: change('description'), maxLength: 16000, disabled: blocked }} /></div>
      <div className="mb-3"><FormElement label="Key" mandatory message={fieldErrors.key} messageTone="error"
        inputProps={{ name: 'key', placeholder: 'PARA_998', value: draft.key, onChange: change('key'), maxLength: 64, disabled: blocked }} /></div>
      <div className="mb-3"><FormElement type="searchable-select" label="Lab Name" message={labError} messageTone="error"
        helperText={moreLabs ? 'More labs match. Refine your search to find a lab.' : undefined}
        inputProps={{ name: 'laboratoryId', placeholder: 'Select Lab', value: draft.laboratoryId, options: labOption ? [labOption] : [], loadOptions: loadLabs,
          cacheOptions: false, clearable: true, disabled: blocked, noOptionsMessage: labError ? 'Labs could not be loaded. Try searching again.' : 'No options found',
          onChange: (value, option) => { setDraft((current) => ({ ...current, laboratoryId: value })); setLabOption(option); } }} /></div>
      <div className="mb-3"><FormElement label="Scheme Abbreviation" mandatory message={fieldErrors.schemeAbbreviation} messageTone="error"
        inputProps={{ name: 'schemeAbbreviation', placeholder: 'Ni', value: draft.schemeAbbreviation, onChange: change('schemeAbbreviation'), maxLength: 64, disabled: blocked }} /></div>
      <ParameterUncertainty name="measurementUncertainty" cfg={uncertaintyConfig} value={uncertaintySpreadsheet(initialGrid)} error={gridError} disabled={blocked} onChange={changeGrid}
        onInvalid={(message) => { gridProblem.current = message; setGridError(message); }} />
      <MasterCustomFields kind="parameter" fields={customFields} loading={customLoading} loadError={customLoadError} values={customValues} storedFields={storedFields}
        errors={fieldErrors} disabled={blocked} generatingId={generatingId} onChange={changeCustomField} onBusy={onUploadBusy} onGenerate={generateField}
        onReload={() => { setCustomLoading(true); setCustomReload((current) => current + 1); }} />
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={blocked} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={blocked || customLoading || Boolean(customLoadError) || Boolean(gridError)}>{saving ? 'Saving...' : parameter ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
