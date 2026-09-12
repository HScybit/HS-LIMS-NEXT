'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';

const relationOption = (row) => ({ value: row.id, label: String(row.name ?? row.id).replace(/[_/-]/g, ' ').replace(/\s+/g, ' ').trim() });

export default function ProductForm({ product }) {
  const router = useRouter(); const search = useSearchParams(); const saveRequest = useRef(null); const newId = useRef(null);
  const [draft, setDraft] = useState(() => ({ name: product?.name ?? '', description: product?.description ?? '', abbreviation: product?.abbreviation ?? null,
    key: product?.key ?? '', jobTemplateId: product?.jobTemplateId ?? null, tagIds: product?.tagIds ?? [] }));
  const [tagOptions, setTagOptions] = useState(() => product?.tags.map(relationOption) ?? []);
  const [templateOptions, setTemplateOptions] = useState(() => product?.jobTemplateId ? [relationOption({ id: product.jobTemplateId, name: product.jobTemplateName })] : []);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({});
  const [tagError, setTagError] = useState(''); const [moreTags, setMoreTags] = useState(false); const tagQuery = useRef(null);
  const [templateError, setTemplateError] = useState(''); const [moreTemplates, setMoreTemplates] = useState(false); const templateQuery = useRef(null);
  const from = search.get('from'); const returnPath = from && /^\/products(?:\?[^#]*)?$/.test(from) ? from : '/products';
  useEffect(() => () => { tagQuery.current?.abort(); templateQuery.current?.abort(); }, []);
  const loadTags = useCallback(async (search) => {
    tagQuery.current?.abort(); const controller = new AbortController(); tagQuery.current = controller;
    try {
      const result = await apiRequest(`/api/masters/products/tags?search=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (controller.signal.aborted) return [];
      setTagError(''); setMoreTags(result.hasMore); return result.rows.map(relationOption);
    } catch (failure) {
      if (!controller.signal.aborted) { setTagError(failure.message); setMoreTags(false); }
      return [];
    }
  }, []);
  const loadTemplates = useCallback(async (search) => {
    templateQuery.current?.abort(); const controller = new AbortController(); templateQuery.current = controller;
    try {
      const result = await apiRequest(`/api/masters/products/templates?search=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (controller.signal.aborted) return [];
      setTemplateError(''); setMoreTemplates(result.hasMore); return result.rows.map(relationOption);
    } catch (failure) {
      if (!controller.signal.aborted) { setTemplateError(failure.message); setMoreTemplates(false); }
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
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const problems = {};
    for (const [field, label] of [['name', 'Name'], ['key', 'Unique Key']]) if (!draft[field].trim()) problems[field] = `${label} is required.`;
    if (draft.key.trim() && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(draft.key.trim())) problems.key = 'Unique Key must start with a letter or number and contain only letters, numbers, dots, slashes, underscores or hyphens.';
    if (draft.tagIds.length > 500) problems.tagIds = 'Select at most 500 tags.';
    setFieldErrors(problems); if (Object.keys(problems).length) return;
    newId.current ??= crypto.randomUUID();
    const body = { ...draft, id: product?.id ?? newId.current, revision: product?.revision ?? 0, name: draft.name.trim(), key: draft.key.trim() };
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await apiRequest('/api/masters/products', { method: 'POST', body: { ...body, requestId: saveRequest.current.id } });
      router.push(returnPath);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4"><form onSubmit={save} noValidate>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="mb-3"><FormElement label="Name" mandatory message={fieldErrors.name} messageTone="error"
        inputProps={{ name: 'name', placeholder: 'Add name of the product', value: draft.name, onChange: change('name'), maxLength: 200, disabled: saving }} /></div>
      <div className="mb-3"><FormElement type="textarea" label="Description"
        inputProps={{ name: 'description', placeholder: 'Add Description of the product', value: draft.description, onChange: change('description'), rows: 3, maxLength: 16000, disabled: saving }} /></div>
      <div className="mb-3"><FormElement label="Abbreviation"
        inputProps={{ name: 'abbreviation', placeholder: 'Add Abbreviation of the product', value: draft.abbreviation ?? '', onChange: change('abbreviation'), maxLength: 64, disabled: saving }} /></div>
      <div className="mb-3"><FormElement label="Unique Key" mandatory message={fieldErrors.key} messageTone="error"
        inputProps={{ name: 'key', placeholder: 'Unique Key', value: draft.key, onChange: change('key'), maxLength: 64, disabled: saving }} /></div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="product-template">Job Template</label></div>
        <SearchableSelect id="product-template" name="jobTemplateId" placeholder="Select Job Template" clearable value={draft.jobTemplateId} options={templateOptions}
          loadOptions={loadTemplates} cacheOptions={false} disabled={saving} invalid={Boolean(templateError)}
          aria-describedby={templateError ? 'product-template-error' : moreTemplates ? 'product-template-more' : undefined}
          noOptionsMessage={templateError ? 'Templates could not be loaded. Try searching again.' : 'No options found'}
          onChange={(value, option) => { setDraft((current) => ({ ...current, jobTemplateId: value || null })); setTemplateOptions(option ? [option] : []); }} />
        {moreTemplates ? <div id="product-template-more" className="smplfy-form-text form-text">More templates match. Refine your search to find a template.</div> : null}
        {templateError ? <div id="product-template-error" className="smplfy-form-element__message smplfy-form-element__message--error">{templateError}</div> : null}
      </div>
      <div className="mb-3 smplfy-form-element"><div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="product-tags">Tags</label></div>
        <SearchableSelect id="product-tags" name="tagIds" placeholder="Select Tags you want to associate with this Product" multiple clearable value={draft.tagIds} options={tagOptions}
          loadOptions={loadTags} cacheOptions={false} disabled={saving} invalid={Boolean(fieldErrors.tagIds || tagError)}
          aria-describedby={fieldErrors.tagIds || tagError ? 'product-tags-error' : moreTags ? 'product-tags-more' : undefined}
          noOptionsMessage={tagError ? 'Tags could not be loaded. Try searching again.' : 'No options found'}
          onChange={(values, options) => { setDraft((current) => ({ ...current, tagIds: values })); setTagOptions(options); clearFieldError('tagIds'); }} />
        {moreTags ? <div id="product-tags-more" className="smplfy-form-text form-text">More tags match. Refine your search to find a tag.</div> : null}
        {fieldErrors.tagIds || tagError ? <div id="product-tags-error" className="smplfy-form-element__message smplfy-form-element__message--error">{fieldErrors.tagIds || tagError}</div> : null}
      </div>
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving}>{saving ? 'Saving...' : product ? 'Update' : 'Create'}</PrimaryButton></div>
    </form></div></div>
  </div></div></div>;
}
