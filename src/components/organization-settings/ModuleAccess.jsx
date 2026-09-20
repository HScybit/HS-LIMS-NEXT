'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { moduleAccessDefinitions, moduleAccessSelectionLimit } from '../../organization-settings/module-access-input.js';

function AccessChoices({ kind, moduleKey, value, selected, disabled, onChange }) {
  const label = kind === 'role' ? 'Roles' : 'Users'; const id = `${kind}-access-${moduleKey}`;
  const [search, setSearch] = useState(''); const [reload, setReload] = useState(0);
  const [result, setResult] = useState({ rows: [], known: new Map(), search: '', page: 0, hasMore: false });
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [selectionError, setSelectionError] = useState('');
  const controller = useRef(null); const pending = useRef(false);
  const load = useCallback(async (page, append) => {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; pending.current = true;
    setLoading(true); setError('');
    try {
      const response = await apiRequest(`/api/organization-settings/module-access/options?kind=${kind}&search=${encodeURIComponent(search)}&page=${page}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setResult(current => ({ rows: append && current.search === search ? [...current.rows, ...response.rows] : response.rows,
        known: new Map([...current.known, ...selected.map(row => [row.id, row]), ...response.rows.map(row => [row.id, row])]),
        search, page: response.page, hasMore: response.hasMore }));
    } catch (failure) { if (!abort.signal.aborted) setError(failure.message); }
    finally { if (controller.current === abort && !abort.signal.aborted) { pending.current = false; setLoading(false); } }
  }, [kind, search, selected]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(1, false); }, search ? 150 : 0);
    const active = controller;
    return () => { clearTimeout(timer); active.current?.abort(); };
  }, [load, reload, search]);
  const options = useMemo(() => {
    const stored = new Map(selected.map(row => [row.id, row]));
    const selections = value.map(id => result.known.get(id) ?? stored.get(id) ?? { id, name: id });
    return [...new Map([...result.rows, ...selections].map(row => [row.id, row])).values()]
      .map(row => ({ value: row.id, label: row.name, title: row.username || row.name }));
  }, [selected, value, result]);
  function change(ids) {
    if (ids.length > moduleAccessSelectionLimit) { setSelectionError(`Select at most ${moduleAccessSelectionLimit} ${label.toLowerCase()}.`); return; }
    setSelectionError(''); onChange(ids);
  }
  function more() { if (result.hasMore && result.search === search && !pending.current) void load(result.page + 1, true); }
  return <div className="mb-3">
    <label className="smplfy-form-element__label d-block mb-2" htmlFor={id}>{label}</label>
    <SearchableSelect id={id} name={id} options={options} value={value} multiple disabled={disabled} isLoading={loading}
      caseInsensitiveValues windowedOptions bulkActionScope="visible" placeholder={`No ${label.toLowerCase()} assigned`}
      invalid={Boolean(selectionError)} onChange={change} onInputChange={(next, meta) => { if (meta.action === 'input-change' || meta.action === 'menu-close') setSearch(next); }}
      onMenuScrollToBottom={more} />
    {selectionError ? <div className="text-danger small mt-1" role="alert">{selectionError}</div> : null}
    {error ? <div className="text-danger small mt-1" role="alert">{error}<button type="button" className="btn btn-link btn-sm" disabled={disabled || loading} onClick={() => setReload(current => current + 1)}>Retry</button></div> : null}
    {result.hasMore ? <button type="button" className="btn btn-link btn-sm px-0" disabled={disabled || loading || result.search !== search} onClick={more}
      aria-label={`Load more ${moduleKey} ${label.toLowerCase()}`}>{loading ? 'Loading...' : `Load more ${label.toLowerCase()}`}</button> : null}
  </div>;
}

export default function ModuleAccess({ modules, disabled, onChange }) {
  const enabled = modules.filter(module => module.enabled).map(module => module.moduleKey);
  function update(key, values) { onChange(modules.map(module => module.moduleKey === key ? { ...module, ...values } : module)); }
  return <>
    <section className="settings-section"><h6 className="settings-section__title">Enabled Modules</h6>
      <label className="smplfy-form-element__label d-block mb-2" htmlFor="modules_enabled">Modules</label>
      <SearchableSelect id="modules_enabled" name="modules_enabled" multiple options={moduleAccessDefinitions.map(module => ({ value: module.key, label: module.label }))}
        value={enabled} disabled={disabled} placeholder="Select modules…" onChange={keys => onChange(modules.map(module => ({ ...module, enabled: keys.includes(module.moduleKey) })))} />
      <div className="text-muted small mt-1">These modules will be available across the application.</div>
    </section>
    <section className="settings-section"><h6 className="settings-section__title">Module-wise Access Control</h6>
      <p className="text-muted small">Access requires an enabled module and a matching user or Default Role assignment.</p>
      <div className="row g-3">{moduleAccessDefinitions.map(definition => {
        const access = modules.find(row => row.moduleKey === definition.key);
        return <div className="col-md-6" key={definition.key}><div className="settings-access-card h-100" role="group" aria-label={definition.label}>
          <div className="settings-access-card__body"><div className="d-flex align-items-center justify-content-between gap-2 mb-3">
            <span className="fw-semibold small">{definition.label}</span>
            {access.roleIds.length + access.userIds.length ? <span className="badge bg-primary">{access.roleIds.length + access.userIds.length} assigned</span> : null}
          </div>
            <AccessChoices kind="role" moduleKey={access.moduleKey} value={access.roleIds} selected={access.roles} disabled={disabled} onChange={roleIds => update(access.moduleKey, { roleIds })} />
            <AccessChoices kind="user" moduleKey={access.moduleKey} value={access.userIds} selected={access.users} disabled={disabled} onChange={userIds => update(access.moduleKey, { userIds })} />
          </div>
        </div></div>;
      })}</div>
    </section>
  </>;
}
