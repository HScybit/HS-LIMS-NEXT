'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage from '../ui/FormPage.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { apiRequest } from '../../lib/api-client.js';

const relationOption = (row) => ({ value: row.id, label: String(row.name ?? row.id) });
const emptyLimit = () => ({ lowerLimit: '', upperLimit: '', lowerInclusive: true, upperInclusive: true, outcome: '', narration: '' });
const emptyVariable = () => ({ key: '', label: '' });

function draftFrom(rule) {
  return {
    name: rule?.isTestGroupParent ? '' : rule?.name ?? '', parentDecisionRuleId: rule?.parentDecisionRuleId ?? null,
    isTestGroupParent: rule?.isTestGroupParent ?? false, testGroupName: rule?.testGroupName ?? '', testGroupUid: rule?.testGroupUid ?? '',
    productId: rule?.productId ?? null, testParameterId: rule?.testParameterId ?? null, methodId: rule?.methodId ?? null,
    sampleCategoryIds: rule?.sampleCategoryIds ?? [], cutoffValue: rule?.cutoffValue ?? 0, minimum: rule?.minimum ?? '', maximum: rule?.maximum ?? '',
    greaterThanText: rule?.greaterThanText ?? '', lessThanText: rule?.lessThanText ?? '', unitOfMeasure: rule?.unitOfMeasure ?? '',
    templateId: rule?.templateId ?? null, isNabl: rule?.isNabl ?? false, minimumSize: rule?.minimumSize ?? '',
    estimatedTimeInDays: rule?.estimatedTimeInDays ?? 0, estimatedCharges: rule?.estimatedCharges ?? 0,
    expressTime: rule?.expressTime ?? 0, expressCharges: rule?.expressCharges ?? 0,
    resultRepresentation: rule?.resultRepresentation ?? '', defaultNarration: rule?.defaultNarration ?? '',
    detectableUpperLimit: rule?.detectableUpperLimit ?? '', detectableLowerLimit: rule?.detectableLowerLimit ?? '',
    detectableUpperLimitText: rule?.detectableUpperLimitText ?? '', detectableLowerLimitText: rule?.detectableLowerLimitText ?? '',
    showDetectableLimitText: rule?.showDetectableLimitText ?? false, showStandardLimitText: rule?.showStandardLimitText ?? false,
    conformanceLimit: rule?.conformanceLimit ?? '', instrumentIds: rule?.instrumentIds ?? [], discipline: rule?.discipline ?? '',
    group: rule?.group ?? '', uniqueKey: rule?.uniqueKey ?? '', hasFormula: rule?.hasFormula ?? false, formula: rule?.formula ?? '',
    formulaText: rule?.formulaText ?? '', formulaVariables: rule?.formulaVariables?.length ? rule.formulaVariables.map(({ key, label }) => ({ key, label })) : [],
    hasDerivedFormula: rule?.hasDerivedFormula ?? false, customFormula: rule?.customFormula ?? '', formulaExpression: rule?.formulaExpression ?? '',
    limits: rule?.limits?.length ? rule.limits.map((limit) => ({ ...limit, lowerLimit: limit.lowerLimit ?? '', upperLimit: limit.upperLimit ?? '', narration: limit.narration ?? '' })) : [],
  };
}

export default function DecisionRuleForm({ rule }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null);
  const [draft, setDraft] = useState(() => draftFrom(rule));
  const [options, setOptions] = useState(() => ({
    parent: rule?.parentDecisionRuleId ? [relationOption({ id: rule.parentDecisionRuleId, name: rule.parentDecisionRuleId })] : [],
    product: rule?.productId ? [relationOption({ id: rule.productId, name: rule.productName ?? rule.productId })] : [],
    parameter: rule?.testParameterId ? [relationOption({ id: rule.testParameterId, name: rule.parameterName ?? rule.testParameterId })] : [],
    method: rule?.methodId ? [relationOption({ id: rule.methodId, name: rule.methodName ?? rule.methodId })] : [],
    categories: rule?.sampleCategoryIds?.map((id) => relationOption({ id, name: id })) ?? [],
    instruments: rule?.instrumentIds?.map((id) => relationOption({ id, name: id })) ?? [],
    template: rule?.templateId ? [relationOption({ id: rule.templateId, name: rule.templateId })] : [],
  }));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const queries = useRef({});
  useEffect(() => () => { for (const controller of Object.values(queries.current)) controller?.abort(); }, []);
  const from = search.get('from'); const returnPath = from && /^\/decision_rules(?:\?[^#]*)?$/.test(from) ? from : '/decision_rules';

  const loadOptionsFrom = useCallback(async (key, url, text) => {
    queries.current[key]?.abort(); const controller = new AbortController(); queries.current[key] = controller;
    try {
      const result = await apiRequest(`${url}${url.includes('?') ? '&' : '?'}search=${encodeURIComponent(text)}`, { signal: controller.signal });
      return controller.signal.aborted ? [] : result.rows.map(relationOption);
    } catch { return []; }
  }, []);
  const loadParents = useCallback((text) => loadOptionsFrom('parent', '/api/masters/decision-rules/parents', text), [loadOptionsFrom]);
  const loadProducts = useCallback((text) => loadOptionsFrom('product', '/api/masters/decision-rules/products', text), [loadOptionsFrom]);
  const loadParameters = useCallback((text) => loadOptionsFrom('parameter', '/api/masters/decision-rules/parameters', text), [loadOptionsFrom]);
  const loadMethods = useCallback((text) => loadOptionsFrom('method', '/api/masters/decision-rules/methods', text), [loadOptionsFrom]);
  const loadCategories = useCallback((text) => loadOptionsFrom('categories', '/api/masters/decision-rules/categories', text), [loadOptionsFrom]);
  const loadInstruments = useCallback((text) => loadOptionsFrom('instruments', '/api/masters/decision-rules/instruments', text), [loadOptionsFrom]);
  const loadTemplates = useCallback((text) => loadOptionsFrom('template', '/api/masters/decision-rules/templates', text), [loadOptionsFrom]);

  async function selectParent(value, option) {
    setDraft((current) => ({ ...current, parentDecisionRuleId: value || null }));
    setOptions((current) => ({ ...current, parent: option ? [option] : [] }));
    if (!value) return;
    try {
      const parent = await apiRequest(`/api/masters/decision-rules/${value}`);
      setDraft((current) => ({ ...current, productId: parent.productId, methodId: parent.methodId }));
      setOptions((current) => ({ ...current, product: [relationOption({ id: parent.productId, name: parent.productName ?? parent.productId })],
        method: [relationOption({ id: parent.methodId, name: parent.methodName ?? parent.methodId })] }));
    } catch (failure) { setError(failure.message); }
  }

  function clearFieldError(field) { setFieldErrors((current) => { if (!current[field]) return current; const { [field]: _error, ...rest } = current; return rest; }); }
  const change = (field) => (event) => { setDraft((current) => ({ ...current, [field]: event.target.value })); clearFieldError(field); };
  const changeChecked = (field) => (checked) => setDraft((current) => ({ ...current, [field]: checked }));
  const changeNumber = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));

  function updateLimit(index, patch) { setDraft((current) => ({ ...current, limits: current.limits.map((limit, i) => i === index ? { ...limit, ...patch } : limit) })); }
  function addLimit() { setDraft((current) => ({ ...current, limits: [...current.limits, emptyLimit()] })); }
  function removeLimit(index) { setDraft((current) => ({ ...current, limits: current.limits.filter((_, i) => i !== index) })); }
  function updateVariable(index, patch) { setDraft((current) => ({ ...current, formulaVariables: current.formulaVariables.map((variable, i) => i === index ? { ...variable, ...patch } : variable) })); }
  function addVariable() { setDraft((current) => ({ ...current, formulaVariables: [...current.formulaVariables, emptyVariable()] })); }
  function removeVariable(index) { setDraft((current) => ({ ...current, formulaVariables: current.formulaVariables.filter((_, i) => i !== index) })); }

  function saveBody() {
    const numeric = (value) => value === '' || value == null ? null : Number(value);
    return { ...draft, id: rule?.id ?? newId.current, revision: rule?.revision ?? 0,
      name: draft.isTestGroupParent ? undefined : (draft.name || '').trim() || null,
      cutoffValue: Number(draft.cutoffValue) || 0, estimatedTimeInDays: Number(draft.estimatedTimeInDays) || 0, estimatedCharges: Number(draft.estimatedCharges) || 0,
      expressTime: Number(draft.expressTime) || 0, expressCharges: Number(draft.expressCharges) || 0,
      detectableUpperLimit: numeric(draft.detectableUpperLimit), detectableLowerLimit: numeric(draft.detectableLowerLimit), conformanceLimit: numeric(draft.conformanceLimit),
      limits: draft.limits.map(({ lowerLimit, upperLimit, lowerInclusive, upperInclusive, outcome, narration }) =>
        ({ lowerLimit: numeric(lowerLimit), upperLimit: numeric(upperLimit), lowerInclusive, upperInclusive, outcome, narration: narration || null })) };
  }
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const problems = {};
    if (draft.isTestGroupParent) { if (!draft.testGroupName.trim()) problems.testGroupName = 'Required.'; if (!draft.testGroupUid.trim()) problems.testGroupUid = 'Required.'; }
    if (!draft.productId) problems.productId = 'Select a Product.'; if (!draft.testParameterId) problems.testParameterId = 'Select a Parameter.';
    if (!draft.methodId) problems.methodId = 'Select a MoA.';
    if (draft.hasFormula && !draft.formula.trim()) problems.formula = 'Formula is required.';
    if (draft.hasDerivedFormula && !draft.customFormula.trim()) problems.customFormula = 'Custom Formula is required.';
    for (const [index, limit] of draft.limits.entries()) {
      if (!limit.outcome.trim()) problems[`limit-${index}`] = 'Outcome is required.';
      else if (limit.lowerLimit === '' && limit.upperLimit === '') problems[`limit-${index}`] = 'Provide at least one limit value.';
    }
    setFieldErrors(problems); if (Object.keys(problems).length) return;
    newId.current ??= crypto.randomUUID();
    const body = saveBody();
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/masters/decision-rules', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }

  const inherited = Boolean(draft.parentDecisionRuleId);
  return <FormPage title={rule ? 'Edit Decision Rule' : 'New Decision Rule'} backTo={returnPath} backLabel="Back to decision rules"
    formId="decision-rule-form" onSubmit={save} saving={saving} submitLabel={rule ? 'Update' : 'Create'} error={error}
    actions={<SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>}>

      <div className="smplfy-form-heading">Test Group</div>
      <div className="mb-3"><div className="smplfy-checkbox-field"><Checkbox id="dr-is-parent" checked={draft.isTestGroupParent} ariaLabel="Is Test Group Parent"
        disabled={saving || inherited} onChange={(checked) => setDraft((current) => ({ ...current, isTestGroupParent: checked }))} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="dr-is-parent">Is Test Group Parent</label></div>
      </div></div>
      {draft.isTestGroupParent ? <div className="row">
        <div className="col-md-6 mb-3"><FormElement label="Test Group Name" mandatory message={fieldErrors.testGroupName} messageTone="error"
          inputProps={{ value: draft.testGroupName, onChange: change('testGroupName'), maxLength: 200, disabled: saving }} /></div>
        <div className="col-md-6 mb-3"><FormElement label="Test Group UID" mandatory message={fieldErrors.testGroupUid} messageTone="error"
          inputProps={{ value: draft.testGroupUid, onChange: change('testGroupUid'), maxLength: 100, disabled: saving, placeholder: 'TEST_GROUP_UID' }} /></div>
      </div> : <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">Parent Decision Rule</label></div>
        <SearchableSelect placeholder="None" clearable value={draft.parentDecisionRuleId} options={options.parent} loadOptions={loadParents} cacheOptions={false} disabled={saving} onChange={selectParent} />
      </div>}

      <div className="smplfy-form-heading">Scope</div>
      {!draft.isTestGroupParent ? <div className="mb-3"><FormElement label="Name" inputProps={{ value: draft.name, onChange: change('name'), maxLength: 200, disabled: saving }} /></div> : null}
      <div className="row">
        <div className="col-md-4 mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">Product</label></div>
          <SearchableSelect placeholder="None" value={draft.productId} options={options.product} loadOptions={loadProducts} cacheOptions={false} disabled={saving || inherited}
            invalid={Boolean(fieldErrors.productId)} onChange={(value, option) => { setDraft((current) => ({ ...current, productId: value || null })); setOptions((current) => ({ ...current, product: option ? [option] : [] })); clearFieldError('productId'); }} />
          {fieldErrors.productId ? <div className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.productId}</div> : null}
        </div>
        <div className="col-md-4 mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">Parameter</label></div>
          <SearchableSelect placeholder="None" value={draft.testParameterId} options={options.parameter} loadOptions={loadParameters} cacheOptions={false} disabled={saving}
            invalid={Boolean(fieldErrors.testParameterId)} onChange={(value, option) => { setDraft((current) => ({ ...current, testParameterId: value || null })); setOptions((current) => ({ ...current, parameter: option ? [option] : [] })); clearFieldError('testParameterId'); }} />
          {fieldErrors.testParameterId ? <div className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.testParameterId}</div> : null}
        </div>
        <div className="col-md-4 mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">MoA</label></div>
          <SearchableSelect placeholder="None" value={draft.methodId} options={options.method} loadOptions={loadMethods} cacheOptions={false} disabled={saving || inherited}
            invalid={Boolean(fieldErrors.methodId)} onChange={(value, option) => { setDraft((current) => ({ ...current, methodId: value || null })); setOptions((current) => ({ ...current, method: option ? [option] : [] })); clearFieldError('methodId'); }} />
          {fieldErrors.methodId ? <div className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.methodId}</div> : null}
        </div>
      </div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">Sample Category</label></div>
        <SearchableSelect placeholder="None" multiple clearable value={draft.sampleCategoryIds} options={options.categories} loadOptions={loadCategories} cacheOptions={false} disabled={saving}
          onChange={(values, opts) => { setDraft((current) => ({ ...current, sampleCategoryIds: values })); setOptions((current) => ({ ...current, categories: opts })); }} />
      </div>

      <div className="smplfy-form-heading">Scientific Rule</div>
      <div className="row">
        <div className="col-md-4 mb-3"><FormElement label="Cut Off Value" inputProps={{ type: 'number', value: draft.cutoffValue, onChange: changeNumber('cutoffValue'), disabled: saving }} /></div>
        <div className="col-md-4 mb-3"><FormElement label="Min" inputProps={{ value: draft.minimum, onChange: change('minimum'), maxLength: 150, disabled: saving }} /></div>
        <div className="col-md-4 mb-3"><FormElement label="Max" inputProps={{ value: draft.maximum, onChange: change('maximum'), maxLength: 150, disabled: saving }} /></div>
      </div>
      <div className="mb-3"><FormElement type="textarea" label="If Greater Text" inputProps={{ value: draft.greaterThanText, onChange: change('greaterThanText'), rows: 2, maxLength: 5000, disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="If Lesser Text" inputProps={{ value: draft.lessThanText, onChange: change('lessThanText'), rows: 2, maxLength: 5000, disabled: saving }} /></div>
      <div className="row">
        <div className="col-md-6 mb-3"><FormElement label="UoM" inputProps={{ value: draft.unitOfMeasure, onChange: change('unitOfMeasure'), maxLength: 100, disabled: saving }} /></div>
        <div className="col-md-6 mb-3"><FormElement label="Min Size" inputProps={{ value: draft.minimumSize, onChange: change('minimumSize'), maxLength: 150, disabled: saving }} /></div>
      </div>
      <div className="row">
        <div className="col-md-3 mb-3"><FormElement label="Estimated Time in Days" inputProps={{ type: 'number', min: 0, value: draft.estimatedTimeInDays, onChange: changeNumber('estimatedTimeInDays'), disabled: saving }} /></div>
        <div className="col-md-3 mb-3"><FormElement label="Estimated Charges" inputProps={{ type: 'number', min: 0, value: draft.estimatedCharges, onChange: changeNumber('estimatedCharges'), disabled: saving }} /></div>
        <div className="col-md-3 mb-3"><FormElement label="Express Time in Days" inputProps={{ type: 'number', min: 0, value: draft.expressTime, onChange: changeNumber('expressTime'), disabled: saving }} /></div>
        <div className="col-md-3 mb-3"><FormElement label="Express Charges" inputProps={{ type: 'number', min: 0, value: draft.expressCharges, onChange: changeNumber('expressCharges'), disabled: saving }} /></div>
      </div>
      <div className="mb-3"><FormElement type="textarea" label="Result Representation" inputProps={{ value: draft.resultRepresentation, onChange: change('resultRepresentation'), rows: 2, maxLength: 5000, disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="Default Narration" inputProps={{ value: draft.defaultNarration, onChange: change('defaultNarration'), rows: 2, maxLength: 5000, disabled: saving }} /></div>
      <div className="row">
        <div className="col-md-6 mb-3"><FormElement label="Detectable Upper Limit" inputProps={{ type: 'number', value: draft.detectableUpperLimit, onChange: changeNumber('detectableUpperLimit'), disabled: saving }} /></div>
        <div className="col-md-6 mb-3"><FormElement label="Detectable Lower Limit" inputProps={{ type: 'number', value: draft.detectableLowerLimit, onChange: changeNumber('detectableLowerLimit'), disabled: saving }} /></div>
        <div className="col-md-6 mb-3"><FormElement label="Detectable Upper Limit Text" inputProps={{ value: draft.detectableUpperLimitText, onChange: change('detectableUpperLimitText'), maxLength: 5000, disabled: saving }} /></div>
        <div className="col-md-6 mb-3"><FormElement label="Detectable Lower Limit Text" inputProps={{ value: draft.detectableLowerLimitText, onChange: change('detectableLowerLimitText'), maxLength: 5000, disabled: saving }} /></div>
      </div>
      {[['showDetectableLimitText', 'Show Detectable Limit Text'], ['showStandardLimitText', 'Show Standard Limit Text'], ['isNabl', 'Is NABL']].map(([key, label]) => <div className="mb-3" key={key}>
        <div className="smplfy-checkbox-field"><Checkbox id={`dr-${key}`} checked={draft[key]} ariaLabel={label} disabled={saving} onChange={changeChecked(key)} />
          <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={`dr-${key}`}>{label}</label></div>
        </div>
      </div>)}
      <div className="mb-3"><FormElement label="Conformance Limit" inputProps={{ type: 'number', value: draft.conformanceLimit, onChange: changeNumber('conformanceLimit'), disabled: saving }} /></div>
      <div className="row">
        <div className="col-md-4 mb-3"><FormElement label="Discipline" inputProps={{ value: draft.discipline, onChange: change('discipline'), maxLength: 150, disabled: saving }} /></div>
        <div className="col-md-4 mb-3"><FormElement label="Group" inputProps={{ value: draft.group, onChange: change('group'), maxLength: 150, disabled: saving }} /></div>
        <div className="col-md-4 mb-3"><FormElement label="Unique Key" inputProps={{ value: draft.uniqueKey, onChange: change('uniqueKey'), maxLength: 100, disabled: saving }} /></div>
      </div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">Template</label></div>
        <SearchableSelect placeholder="None" clearable value={draft.templateId} options={options.template} loadOptions={loadTemplates} cacheOptions={false} disabled={saving}
          onChange={(value, option) => { setDraft((current) => ({ ...current, templateId: value || null })); setOptions((current) => ({ ...current, template: option ? [option] : [] })); }} />
      </div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label">Instruments</label></div>
        <SearchableSelect placeholder="None" multiple clearable value={draft.instrumentIds} options={options.instruments} loadOptions={loadInstruments} cacheOptions={false} disabled={saving}
          onChange={(values, opts) => { setDraft((current) => ({ ...current, instrumentIds: values })); setOptions((current) => ({ ...current, instruments: opts })); }} />
      </div>

      <div className="smplfy-form-heading">Formula</div>
      <div className="mb-3"><div className="smplfy-checkbox-field"><Checkbox id="dr-has-formula" checked={draft.hasFormula} ariaLabel="Has Formula" disabled={saving} onChange={changeChecked('hasFormula')} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="dr-has-formula">Has Formula</label></div>
      </div></div>
      {draft.hasFormula ? <>
        <div className="mb-3"><FormElement label="Formula" mandatory message={fieldErrors.formula} messageTone="error" inputProps={{ value: draft.formula, onChange: change('formula'), maxLength: 5000, disabled: saving }} /></div>
        <div className="mb-3"><FormElement type="textarea" label="Formula Text" inputProps={{ value: draft.formulaText, onChange: change('formulaText'), rows: 2, maxLength: 5000, disabled: saving }} /></div>
        <div className="mb-3">
          <div className="d-flex justify-content-between align-items-center mb-2"><label className="smplfy-form-element__label mb-0">Formula Variables</label>
            <SecondaryButton type="button" leftIcon="plus" disabled={saving} onClick={addVariable}>Add Variable</SecondaryButton></div>
          {draft.formulaVariables.map((variable, index) => <div className="row align-items-center mb-2" key={index}>
            <div className="col-5"><FormElement inputProps={{ placeholder: 'Key', value: variable.key, onChange: (event) => updateVariable(index, { key: event.target.value }), maxLength: 64, disabled: saving }} /></div>
            <div className="col-5"><FormElement inputProps={{ placeholder: 'Label', value: variable.label, onChange: (event) => updateVariable(index, { label: event.target.value }), maxLength: 200, disabled: saving }} /></div>
            <div className="col-2"><button type="button" className="btn btn-sm btn-outline-danger" disabled={saving} onClick={() => removeVariable(index)}><AppIcon name="trash" size="0.85em" /></button></div>
          </div>)}
        </div>
      </> : null}
      <div className="mb-3"><div className="smplfy-checkbox-field"><Checkbox id="dr-has-derived" checked={draft.hasDerivedFormula} ariaLabel="Has Derived Formula" disabled={saving} onChange={changeChecked('hasDerivedFormula')} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="dr-has-derived">Has Derived Formula</label></div>
      </div></div>
      {draft.hasDerivedFormula ? <div className="mb-3"><FormElement label="Custom Formula" mandatory message={fieldErrors.customFormula} messageTone="error"
        inputProps={{ value: draft.customFormula, onChange: change('customFormula'), maxLength: 5000, disabled: saving }} /></div> : null}

      <div className="smplfy-form-heading">Limits</div>
      <div className="d-flex justify-content-end mb-2"><SecondaryButton type="button" leftIcon="plus" disabled={saving} onClick={addLimit}>Add Limit</SecondaryButton></div>
      {draft.limits.map((limit, index) => <div className="border rounded p-3 mb-3" key={index}>
        {fieldErrors[`limit-${index}`] ? <div className="alert alert-danger py-1 px-2 mb-2">{fieldErrors[`limit-${index}`]}</div> : null}
        <div className="row">
          <div className="col-md-3 mb-2"><FormElement label="Lower Limit" inputProps={{ type: 'number', value: limit.lowerLimit, onChange: (event) => updateLimit(index, { lowerLimit: event.target.value }), disabled: saving }} /></div>
          <div className="col-md-3 mb-2"><FormElement label="Upper Limit" inputProps={{ type: 'number', value: limit.upperLimit, onChange: (event) => updateLimit(index, { upperLimit: event.target.value }), disabled: saving }} /></div>
          <div className="col-md-4 mb-2"><FormElement label="Outcome" mandatory inputProps={{ value: limit.outcome, onChange: (event) => updateLimit(index, { outcome: event.target.value }), maxLength: 100, disabled: saving }} /></div>
          <div className="col-md-2 mb-2 d-flex align-items-end"><button type="button" className="btn btn-sm btn-outline-danger w-100" disabled={saving} onClick={() => removeLimit(index)}><AppIcon name="trash" size="0.85em" /> Remove</button></div>
        </div>
        <div className="row">
          <div className="col-md-3"><div className="smplfy-checkbox-field"><Checkbox id={`limit-${index}-lower-inc`} checked={limit.lowerInclusive} ariaLabel="Lower Inclusive" disabled={saving} onChange={(checked) => updateLimit(index, { lowerInclusive: checked })} />
            <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={`limit-${index}-lower-inc`}>Lower Inclusive</label></div></div></div>
          <div className="col-md-3"><div className="smplfy-checkbox-field"><Checkbox id={`limit-${index}-upper-inc`} checked={limit.upperInclusive} ariaLabel="Upper Inclusive" disabled={saving} onChange={(checked) => updateLimit(index, { upperInclusive: checked })} />
            <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={`limit-${index}-upper-inc`}>Upper Inclusive</label></div></div></div>
          <div className="col-md-6"><FormElement label="Narration" inputProps={{ value: limit.narration, onChange: (event) => updateLimit(index, { narration: event.target.value }), maxLength: 2000, disabled: saving }} /></div>
        </div>
      </div>)}

  </FormPage>;
}
