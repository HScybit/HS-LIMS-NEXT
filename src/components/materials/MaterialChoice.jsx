'use client';

import { useEffect, useRef, useState } from 'react';
import FormElement from '../ui/FormElement.jsx';
import { apiRequest } from '../../lib/api-client.js';

export default function MaterialChoice({ kind, materialId, label, value, selected, onChange, disabled, message }) {
  const [search, setSearch] = useState(''); const [state, setState] = useState({ items: [], page: 0, hasMore: false, loading: true, error: '', selected: null });
  const pending = useRef(null); const menuOpen = useRef(false); const [retry, setRetry] = useState(0);
  const queryKey = JSON.stringify([kind, materialId ?? '', value ?? '', search, retry]);
  useEffect(() => {
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    const timeout = window.setTimeout(async () => {
      setState(current => ({ ...current, loading: true, error: '' }));
      const query = new URLSearchParams({ kind, page: '1', search, ...(materialId ? { materialId } : {}), ...(value ? { selectedId: value } : {}) });
      try {
        const result = await apiRequest(`/api/materials/choices?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ ...result, queryKey, loading: false, error: '' });
      } catch (error) { if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: error.message })); }
    }, search ? 200 : 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [kind, materialId, value, search, retry, queryKey]);

  async function more() {
    if (state.loading || !state.hasMore || state.queryKey !== queryKey) return;
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    setState(current => ({ ...current, loading: true }));
    const query = new URLSearchParams({ kind, page: String(state.page + 1), search, ...(materialId ? { materialId } : {}) });
    try {
      const result = await apiRequest(`/api/materials/choices?${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) setState(current => ({ ...result, queryKey, selected: current.selected, items: [...new Map([...current.items, ...result.items].map(item => [item.id, item])).values()], loading: false, error: '' }));
    } catch (error) { if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: error.message })); }
  }
  useEffect(() => () => pending.current?.abort(), []);
  const selection = state.selected ?? selected;
  const items = [...state.items, ...(selection?.id === value && !state.items.some(item => item.id === value) ? [selection] : [])].map(item => ({ ...item, value: item.id }));
  return <div><FormElement type="searchable-select" label={label} mandatory message={message} messageTone="error" inputProps={{ value, options: items, disabled,
    placeholder: `Select ${kind === 'batch' ? 'batch' : kind}`, isLoading: state.loading, filterOption: null, windowedOptions: true,
    onInputChange: (text, meta) => { if (meta.action === 'input-change') setSearch(text.slice(0, 500)); }, onMenuScrollToBottom: more,
    onMenuOpen: () => { menuOpen.current = true; }, onMenuClose: () => { menuOpen.current = false; },
    // Let the select close its menu before Escape reaches the surrounding modal.
    onKeyDown: event => { if (event.key === 'Escape' && menuOpen.current) event.stopPropagation(); },
    isOptionDisabled: option => option.exhausted || option.active === false,
    onChange: (nextValue, option) => onChange(nextValue, option), noOptionsMessage: state.error ? 'Could not load choices.' : 'No options found',
    formatOptionLabel: option => <span className={`d-flex justify-content-between gap-3${option.exhausted ? ' text-danger' : ''}`} title={option.exhausted ? 'No quantity available to issue out.' : undefined}>
      <span>{option.label}{option.warning ? ' ⚠' : ''}</span>{option.expiryDate ? <span className="text-nowrap small">{option.expiryDate.split('-').reverse().join('/')}</span> : null}</span>,
  }} />{state.error ? <div className="small text-danger" role="alert">{state.error} <button type="button" className="btn btn-link btn-sm p-0" disabled={disabled} onClick={() => setRetry(current => current + 1)}>Retry</button></div> : null}</div>;
}
