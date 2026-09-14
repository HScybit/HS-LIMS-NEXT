'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import { apiRequest } from '../../lib/api-client.js';

const option = (row) => ({ value: row.id, label: `${row.name}${row.active ? '' : ' (inactive)'}`, isDisabled: !row.active });

export function useWorkflowNodeReferences(roleIds, templateId) {
  const selection = JSON.stringify({ roles: [...new Set(roleIds)].sort(), templates: templateId ? [templateId] : [] });
  const [result, setResult] = useState(null); const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load(kind, selectedIds) {
      const batches = [];
      for (let offset = 0; offset < Math.max(1, selectedIds.length); offset += 500) {
        batches.push(apiRequest(`/api/workflows/lookups/${kind}`, { method: 'POST', body: { selectedIds: selectedIds.slice(offset, offset + 500) }, signal: controller.signal }));
      }
      const values = await Promise.all(batches);
      return { rows: values[0].rows, hasMore: values[0].hasMore, selected: values.flatMap((value) => value.selected) };
    }
    const ids = JSON.parse(selection);
    Promise.all([load('roles', ids.roles), load('templates', ids.templates)])
      .then(([roles, templates]) => { if (!controller.signal.aborted) setResult({ selection, reload, roles, templates }); })
      .catch((error) => { if (!controller.signal.aborted) setResult({ selection, reload, error }); });
    return () => controller.abort();
  }, [selection, reload]);
  const current = result?.selection === selection && result.reload === reload ? result : null;
  return { ...current, loading: !current, retry: () => setReload((value) => value + 1) };
}

export function WorkflowReferenceField({ label, kind, value, onChange, catalog, multiple = false, disabled }) {
  const id = useId(); const [searched, setSearched] = useState([]); const [selectedOptions, setSelectedOptions] = useState([]); const [error, setError] = useState(null);
  const options = useMemo(() => {
    const selected = multiple ? value : value ? [value] : [];
    const rows = new Map([...catalog?.rows ?? [], ...catalog?.selected ?? [], ...searched].map((row) => [row.id, option(row)]));
    for (const item of selectedOptions) rows.set(item.value, item);
    return selected.map((id) => rows.get(id) ?? { value: id, label: `Unavailable ${kind === 'roles' ? 'role' : 'template'}`, isDisabled: true });
  }, [catalog, searched, selectedOptions, value, multiple, kind]);
  async function loadOptions(search) {
    try {
      const result = await apiRequest(`/api/workflows/lookups/${kind}`, { method: 'POST', body: { search } });
      setSearched(result.rows);
      setError(null); return result.rows.map(option);
    } catch (failure) { setError(failure.message); return []; }
  }
  return <div className="workflow-field"><label htmlFor={id}>{label}</label>
    <SearchableSelect inputId={id} value={value ?? ''} onChange={(next, selected) => {
      if (multiple && next.length > 500) { setError('Select at most 500 roles.'); return; }
      setSelectedOptions(multiple ? selected : selected ? [selected] : []); setError(null); onChange(next);
    }} options={options} loadOptions={loadOptions} defaultOptions={(catalog?.rows ?? []).map(option)} cacheOptions={false}
      multiple={multiple} disabled={disabled} clearable placeholder="Select" maxVisibleValues={2} />
    {error ? <small className="text-danger" role="alert">{error} Type again to retry.</small> : null}
  </div>;
}
