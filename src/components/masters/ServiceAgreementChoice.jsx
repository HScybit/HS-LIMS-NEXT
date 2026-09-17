'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FormElement from '../ui/FormElement.jsx';
import { apiRequest } from '../../lib/api-client.js';

const empty = [];
export default function ServiceAgreementChoice({ kind, id, label, value, onChange, multiple = false, disabled, error, placeholder, retained = empty }) {
  const [rows, setRows] = useState([]); const [initial, setInitial] = useState([]); const [failure, setFailure] = useState(''); const [hasMore, setHasMore] = useState(false);
  const controllers = useRef(new Set()); const requests = useRef(new Map()); const selected = JSON.stringify(multiple ? value : value ? [value] : []);
  const load = useCallback(search => {
    if (requests.current.has(search)) return requests.current.get(search);
    const controller = new AbortController(); controllers.current.add(controller);
    const pending = apiRequest('/api/masters/service-agreements/options', { method: 'POST', body: { kind, search, selectedIds: JSON.parse(selected) }, signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return [];
      const options = result.rows.map(row => ({ value: row.id, label: row.name }));
      setRows(current => [...new Map([...current, ...result.retained.map(row => ({ value: row.id, label: row.name })), ...options].map(row => [row.value, row])).values()]);
      if (!search) setInitial(options);
      setFailure(''); setHasMore(result.hasMore); return options;
    }).catch(error => { if (!controller.signal.aborted) setFailure(error.message); return []; })
      .finally(() => { controllers.current.delete(controller); if (requests.current.get(search) === pending) requests.current.delete(search); });
    requests.current.set(search, pending); return pending;
  }, [kind, selected]);
  useEffect(() => {
    void load(''); const active = controllers.current; const pending = requests.current;
    return () => { for (const controller of active) controller.abort(); pending.clear(); };
  }, [load]);
  const options = useMemo(() => [...new Map([...retained.map(row => ({ value: row.id, label: row.name })), ...rows].map(row => [row.value, row])).values()], [retained, rows]);
  return <div><FormElement type="searchable-select" label={label} mandatory message={error || failure} messageTone="error"
    inputProps={{ id, value, options, defaultOptions: initial, loadOptions: load, cacheOptions: false, multiple, clearable: false,
      disabled, onChange, placeholder, invalid: Boolean(error || failure), caseInsensitiveValues: true, bulkActionScope: 'visible' }} />
    {hasMore ? <div className="smplfy-form-text form-text">More choices match. Refine your search.</div> : null}
    {failure ? <button type="button" className="btn btn-link btn-sm" disabled={disabled} onClick={() => void load('')}>Retry choices</button> : null}
  </div>;
}
