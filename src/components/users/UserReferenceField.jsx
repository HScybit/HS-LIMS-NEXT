'use client';

import { useEffect, useMemo, useState } from 'react';
import FormElement from '../ui/FormElement.jsx';
import { apiRequest } from '../../lib/api-client.js';

const option = (row, includeInactive = false) => ({ value: row.id, label: `${row.name}${row.active ? '' : ' (inactive)'}`, isDisabled: !row.active && !includeInactive });
export async function userReferences(kind, input = {}, signal) {
  return apiRequest(`/api/users/profile-references?query=${encodeURIComponent(JSON.stringify({ kind, ...input }))}`, { signal });
}

export default function UserReferenceField({ kind, name = kind, label, placeholder, value, savedLabel, onChange, disabled, required, error, excludeUserId, includeInactive = false }) {
  const [selected, setSelected] = useState(null); const [loadError, setLoadError] = useState(''); const [reload, setReload] = useState(0);
  const [selectedError, setSelectedError] = useState('');
  const [catalog, setCatalog] = useState(null); const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    userReferences(kind, { excludeUserId, ...(includeInactive ? { includeInactive: true } : {}) }, controller.signal).then(result => {
      if (!controller.signal.aborted) { setCatalog(result.rows.map(row => option(row, includeInactive))); setHasMore(result.hasMore); setLoadError(''); }
    }).catch(failure => { if (!controller.signal.aborted) setLoadError(failure.message); });
    return () => controller.abort();
  }, [kind, excludeUserId, includeInactive, reload]);
  useEffect(() => {
    if (!value || selected?.value === value) return undefined;
    const controller = new AbortController();
    userReferences(kind, { selectedIds: [value] }, controller.signal).then(result => {
      if (!controller.signal.aborted) { setSelected(result.rows[0] ? option(result.rows[0], includeInactive) : { value, label: savedLabel || 'Unavailable selection', isDisabled: true }); setSelectedError(''); }
    }).catch(failure => { if (!controller.signal.aborted) setSelectedError(failure.message); });
    return () => controller.abort();
  }, [kind, value, savedLabel, selected?.value, includeInactive, reload]);
  const options = useMemo(() => selected?.value === value ? [selected] : value ? [{ value, label: savedLabel || 'Loading selection…' }] : [], [selected, value, savedLabel]);
  async function loadOptions(search) {
    try { const result = await userReferences(kind, { search, excludeUserId, ...(includeInactive ? { includeInactive: true } : {}) }); setLoadError(''); setHasMore(result.hasMore); return result.rows.map(row => option(row, includeInactive)); }
    catch (failure) { setLoadError(failure.message); return []; }
  }
  return <div className="mb-3 user-reference-field" aria-busy={Boolean(!catalog && !loadError || value && selected?.value !== value && !selectedError)}><FormElement type="searchable-select" label={label} mandatory={required} message={error} messageTone="error"
    inputProps={{ name, value, options, defaultOptions: catalog ?? [], loadOptions, cacheOptions: false, disabled, clearable: !required,
      placeholder, isLoading: !catalog && !loadError, onChange: (next, selection) => { setSelected(selection); setSelectedError(''); onChange(next); } }} />
    {hasMore ? <div className="form-text">Type to find more {label.toLowerCase()} options.</div> : null}
    {loadError || selectedError ? <div className="text-danger small" role="alert">{loadError || selectedError}<button type="button" className="btn btn-link btn-sm" disabled={disabled} onClick={() => setReload(value => value + 1)}>Retry loading {label}</button></div> : null}
  </div>;
}
