'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import DataTable from '../ui/DataTable.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import { apiRequest } from '../../lib/api-client.js';

const ScopeContext = createContext(null);
const emptySelection = [];
function ScopeChoice({ parameter, kind }) {
  const { scopes, change, disabled } = useContext(ScopeContext); const key = kind === 'product' ? 'products' : 'methods';
  const selected = scopes[parameter.id]?.[key] ?? emptySelection;
  const [choices, setChoices] = useState([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [more, setMore] = useState(false);
  const controller = useRef(null); const timer = useRef(null); const search = useRef('');
  useEffect(() => () => { controller.current?.abort(); window.clearTimeout(timer.current); }, []);
  async function load(value) {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setLoading(true); setError(''); search.current = value;
    try {
      const result = await apiRequest('/api/operations/nabl-certifications/catalog', { method: 'POST', signal: abort.signal,
        body: { kind, parameterId: parameter.id, search: value, selectedIds: selected.map(item => item.id), pageSize: 50 } });
      if (!abort.signal.aborted) { setChoices(result.rows); setMore(result.totalCount > result.rows.length); }
    } catch (failure) { if (!abort.signal.aborted) setError(failure.message); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  const options = useMemo(() => [...new Map([...selected, ...choices].map(item => [item.id, { value: item.id, label: `${item.name}${item.active === false ? ' (inactive)' : ''}`, record: item }])).values()], [choices, selected]);
  return <div style={{ minWidth: 190 }}>
    <SearchableSelect id={`${kind}-${parameter.id}`} aria-label={`${kind === 'product' ? 'Products' : 'MoA'} for ${parameter.name}`} multiple searchable
      value={selected.map(item => item.id)} options={options} disabled={disabled} isLoading={loading} noOptionsMessage={error || `No decision-rule ${kind === 'product' ? 'products' : 'methods'}`}
      placeholder={kind === 'product' ? 'Select Products' : 'Select MOAs'} onMenuOpen={() => { window.clearTimeout(timer.current); void load(search.current); }}
      onInputChange={(value, meta) => {
        search.current = value;
        if (meta.action === 'input-change') { window.clearTimeout(timer.current); controller.current?.abort(); timer.current = window.setTimeout(() => void load(value), 200); }
      }}
      onChange={(_ids, items) => change(parameter, key, items.map(item => item.record))} />
    {more ? <div className="small text-muted mt-1">Search to narrow the first 50 matches.</div> : null}
    {error ? <div role="alert" className="small text-danger">{error}<button type="button" className="btn btn-link btn-sm" onClick={() => void load(search.current)}>Retry choices</button></div> : null}
  </div>;
}
function Accreditation({ parameterId }) {
  const { scopes } = useContext(ScopeContext); const scope = scopes[parameterId]; const accredited = scope?.products.length > 0 && scope?.methods.length > 0;
  return <span className={`badge rounded-pill ${accredited ? 'text-bg-success' : 'text-bg-light border text-secondary'}`}>{accredited ? 'NABL' : 'NON NABL'}</span>;
}
const columns = [
  { key: 'name', header: 'Parameter', filterable: false, render: row => <div><div className="fw-semibold text-break">{row.name}</div><div className="small text-muted">{row.schemeAbbreviation}</div></div> },
  { key: 'accredited', header: 'NABL', filterable: false, render: row => <Accreditation parameterId={row.id} /> },
  { key: 'products', header: 'Products', filterable: false, render: row => <ScopeChoice parameter={row} kind="product" /> },
  { key: 'methods', header: 'MOAs', filterable: false, render: row => <ScopeChoice parameter={row} kind="method" /> },
];
export default function NablScopes({ scopes, change, disabled, retainedIds }) {
  const loadRows = useCallback(async ({ page, pageSize, search }) => {
    const result = await apiRequest('/api/operations/nabl-certifications/catalog', { method: 'POST', body: { kind: 'parameter', page, pageSize, search, selectedIds: retainedIds } });
    return { ...result, rows: result.rows.map(row => ({ ...row, _id: row.id })) };
  }, [retainedIds]);
  return <ScopeContext.Provider value={{ scopes, change, disabled }}><DataTable columns={columns} loadRows={loadRows} /></ScopeContext.Provider>;
}
