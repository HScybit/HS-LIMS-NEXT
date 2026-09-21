'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage, { FormSection, FormField } from '../ui/FormPage.jsx';
import { apiRequest } from '../../lib/api-client.js';

const relationOption = (row) => ({ value: row.id, label: String(row.name ?? row.id) });
const templatePurposes = [['sample', 'Sample Template'], ['datasheet', 'Datasheet Template'], ['report', 'Report Template'], ['label', 'Label Template']];

export default function SampleCategoryForm({ category }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: category?.name ?? '', description: category?.description ?? '', abbreviation: category?.abbreviation ?? '',
    retentionDays: category?.retentionDays ?? 0, estimatedTimeInDays: category?.estimatedTimeInDays ?? 0,
    enableEvents: category?.enableEvents ?? false, enableReissue: category?.enableReissue ?? false,
    workflowId: category?.workflowId ?? null, userIds: category?.userIds ?? [], includedFieldIds: category?.includedFieldIds ?? [],
    templates: { sample: category?.templates?.sample ?? null, datasheet: category?.templates?.datasheet ?? null, report: category?.templates?.report ?? null, label: category?.templates?.label ?? null } }));
  const [workflowOptions, setWorkflowOptions] = useState(() => category?.workflowId ? [relationOption({ id: category.workflowId, name: category.workflowName })] : []);
  const [userOptions, setUserOptions] = useState(() => category?.users?.map((user) => relationOption({ id: user.id, name: user.name })) ?? []);
  const [fieldOptions, setFieldOptions] = useState(() => category?.includedFields?.map((field) => relationOption({ id: field.id, name: field.label })) ?? []);
  const [templateOptions, setTemplateOptions] = useState({ sample: [], datasheet: [], report: [], label: [] });
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const from = search.get('from'); const returnPath = from && /^\/sample_categories(?:\?[^#]*)?$/.test(from) ? from : '/sample_categories';
  const queries = useRef({});
  useEffect(() => () => { for (const controller of Object.values(queries.current)) controller?.abort(); }, []);
  const loadOptionsFrom = useCallback(async (key, url, text) => {
    queries.current[key]?.abort(); const controller = new AbortController(); queries.current[key] = controller;
    try {
      const result = await apiRequest(`${url}${url.includes('?') ? '&' : '?'}search=${encodeURIComponent(text)}`, { signal: controller.signal });
      return controller.signal.aborted ? [] : result.rows.map(relationOption);
    } catch { return []; }
  }, []);
  const loadWorkflows = useCallback((text) => loadOptionsFrom('workflow', '/api/masters/sample-categories/workflows', text), [loadOptionsFrom]);
  const loadUsers = useCallback((text) => loadOptionsFrom('users', '/api/masters/sample-categories/users', text), [loadOptionsFrom]);
  const loadFields = useCallback((text) => loadOptionsFrom('fields', '/api/masters/sample-categories/fields', text), [loadOptionsFrom]);
  const loadTemplates = useCallback((purpose) => (text) =>
    loadOptionsFrom(`template-${purpose}`, `/api/masters/sample-categories/templates?purpose=${purpose}`, text), [loadOptionsFrom]);

  function clearFieldError(field) {
    setFieldErrors((current) => { if (!current[field]) return current; const { [field]: _error, ...rest } = current; return rest; });
  }
  const change = (field) => (event) => { setDraft((current) => ({ ...current, [field]: event.target.value })); clearFieldError(field); };
  const changeChecked = (field) => (checked) => setDraft((current) => ({ ...current, [field]: checked }));
  const changeNumber = (field) => (event) => { const value = event.target.value; setDraft((current) => ({ ...current, [field]: value === '' ? 0 : Number(value) })); clearFieldError(field); };

  function saveBody() {
    return { ...draft, id: category?.id ?? newId.current, revision: category?.revision ?? 0, name: draft.name.trim(), description: draft.description.trim(),
      abbreviation: draft.abbreviation.trim() };
  }
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const problems = {};
    if (!draft.name.trim()) problems.name = 'Name is required.';
    if (!draft.abbreviation.trim()) problems.abbreviation = 'Abbreviation is required.';
    if (!draft.workflowId) problems.workflowId = 'Select a Workflow.';
    setFieldErrors(problems); if (Object.keys(problems).length) return;
    newId.current ??= crypto.randomUUID();
    const body = saveBody();
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/masters/sample-categories', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <FormPage title={category ? 'Edit Sample Category' : 'New Sample Category'} backTo={returnPath} backLabel="Back to sample categories"
    formId="sample-category-form" onSubmit={save} saving={saving} submitLabel={category ? 'Update' : 'Create'} error={error}
    actions={<SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>}>
    <FormSection title="Category Details">
      <FormField><FormElement label="Name" mandatory message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Add name of the Sample Category', value: draft.name, onChange: change('name'), maxLength: 200, disabled: saving }} /></FormField>
      <FormField><FormElement label="Abbreviation" mandatory message={fieldErrors.abbreviation} messageTone="error"
        inputProps={{ name: 'abbreviation', placeholder: 'The abbreviation for the category', value: draft.abbreviation, onChange: change('abbreviation'), maxLength: 64, disabled: saving }} /></FormField>
      <FormField span={12}><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Add Description of the Sample Category', value: draft.description, onChange: change('description'), rows: 3, maxLength: 16000, disabled: saving }} /></FormField>
    </FormSection>

    <FormSection title="Handling">
      <FormField><FormElement label="Retention Days" mandatory
        inputProps={{ type: 'number', name: 'retentionDays', min: 0, step: 1, value: draft.retentionDays, onChange: changeNumber('retentionDays'), disabled: saving }} /></FormField>
      <FormField><FormElement label="Estimated Time in Days"
        inputProps={{ type: 'number', name: 'estimatedTimeInDays', min: 0, step: 0.5, value: draft.estimatedTimeInDays, onChange: changeNumber('estimatedTimeInDays'), disabled: saving }} /></FormField>
      {[['enableEvents', 'Enable Events'], ['enableReissue', 'Enable Reissue']].map(([key, label]) => <FormField key={key}>
        <div className="smplfy-checkbox-field"><Checkbox id={`sample-category-${key}`} checked={draft[key]} ariaLabel={label} disabled={saving} onChange={changeChecked(key)} />
          <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={`sample-category-${key}`}>{label}</label></div>
        </div>
      </FormField>)}
    </FormSection>

    <FormSection title="Workflow and Access">
      <FormField>
        <div className="smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="sample-category-workflow">Workflow</label></div>
          <SearchableSelect id="sample-category-workflow" name="workflowId" placeholder="Select Workflow" clearable value={draft.workflowId} options={workflowOptions}
            loadOptions={loadWorkflows} cacheOptions={false} disabled={saving} invalid={Boolean(fieldErrors.workflowId)}
            onChange={(value, option) => { setDraft((current) => ({ ...current, workflowId: value || null })); setWorkflowOptions(option ? [option] : []); clearFieldError('workflowId'); }} />
          {fieldErrors.workflowId ? <div className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.workflowId}</div> : null}
        </div>
      </FormField>
      <FormField>
        <div className="smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="sample-category-users">Users</label></div>
          <SearchableSelect id="sample-category-users" name="userIds" placeholder="Select Users" multiple clearable value={draft.userIds} options={userOptions}
            loadOptions={loadUsers} cacheOptions={false} disabled={saving}
            onChange={(values, options) => { setDraft((current) => ({ ...current, userIds: values })); setUserOptions(options); }} />
        </div>
      </FormField>
      <FormField span={12}>
        <div className="smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="sample-category-fields">Custom Fields</label></div>
          <SearchableSelect id="sample-category-fields" name="includedFieldIds" placeholder="Select Sample-Product Custom Fields" multiple clearable value={draft.includedFieldIds} options={fieldOptions}
            loadOptions={loadFields} cacheOptions={false} disabled={saving}
            onChange={(values, options) => { setDraft((current) => ({ ...current, includedFieldIds: values })); setFieldOptions(options); }} />
        </div>
      </FormField>
    </FormSection>

    <FormSection title="Templates" last>
      {templatePurposes.map(([purpose, label]) => <FormField key={purpose}>
        <div className="smplfy-form-element">
          <div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor={`sample-category-template-${purpose}`}>{label}</label></div>
          <SearchableSelect id={`sample-category-template-${purpose}`} name={`templates.${purpose}`} placeholder={`Select ${label}`} clearable
            value={draft.templates[purpose]} options={templateOptions[purpose]} loadOptions={loadTemplates(purpose)} cacheOptions={false} disabled={saving}
            onChange={(value, option) => {
              setDraft((current) => ({ ...current, templates: { ...current.templates, [purpose]: value || null } }));
              setTemplateOptions((current) => ({ ...current, [purpose]: option ? [option] : [] }));
            }} />
        </div>
      </FormField>)}
    </FormSection>
  </FormPage>;
}
