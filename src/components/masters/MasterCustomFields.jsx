'use client';

import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import MasterCustomFieldFile from './MasterCustomFieldFile.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { customFieldControl } from '../../custom-fields/form-values.js';
import { customFieldDateInput, customFieldDateTimeInput } from '../../custom-fields/dates.js';

const userOption = (id, name) => ({ value: id, label: String(name ?? id).replace(/[_/-]/g, ' ').replace(/\s+/g, ' ').trim() });

export function CustomFieldControl({ kind, field, value, stored, disabled, error, onChange, onBusy, userOptions, defaultUserOptions, loadUsers, lookupOptions, lookupSelectOptions }) {
  const control = customFieldControl(field, lookupOptions); const id = `${kind}-custom-field-${field.id}`;
  if (control.type === 'file') return <MasterCustomFieldFile {...{ kind, field, value, stored, disabled, error, onChange, onBusy }} />;
  if (control.type === 'boolean') return <div className="mb-3">
    <div className="smplfy-checkbox-field"><Checkbox id={id} name={id} checked={Boolean(value)} onChange={onChange} ariaLabel={field.label}
      disabled={disabled} invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
      <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={id}>{field.label}
        {control.required ? <span className="smplfy-form-element__required ms-1">*</span> : null}</label></div>
    </div>{error ? <div id={`${id}-error`} className="smplfy-form-element__message smplfy-form-element__message--error">{error}</div> : null}
  </div>;
  if (control.type === 'array') {
    const items = Array.isArray(value) ? value : [''];
    return <div className="mb-3" role="group" aria-labelledby={`${id}-label`} aria-describedby={error ? `${id}-error` : undefined}>
      <div className="d-flex align-items-center justify-content-between mb-2"><div className="d-flex align-items-center gap-1">
        <label id={`${id}-label`} className="smplfy-form-label form-label mb-0">{field.label}</label>
        {control.required ? <span className="smplfy-form-required">*</span> : null}</div>
        <button type="button" className="btn btn-sm btn-primary" aria-label={`Add ${field.label} item`} disabled={disabled || items.length >= 500}
          onClick={() => onChange([...items, ''])}>+</button></div>
      {items.map((item, index) => <div key={index} className="d-flex align-items-center gap-2 mb-2"><div className="flex-grow-1">
        <FormElement inputProps={{ id: `${id}-${index}`, value: item, placeholder: `Enter ${field.label}`, disabled, maxLength: 16000,
          'aria-label': `${field.label} item ${index + 1}`, onChange: (event) => { const next = [...items]; next[index] = event.target.value; onChange(next); } }} />
      </div><button type="button" className="btn btn-sm btn-danger" aria-label={`Remove ${field.label} item ${index + 1}`} disabled={disabled}
        onClick={() => { const next = items.filter((_, position) => position !== index); onChange(next.length ? next : ['']); }}><AppIcon name="trash" size={13} /></button></div>)}
      {error ? <div id={`${id}-error`} className="smplfy-form-element__message smplfy-form-element__message--error">{error}</div> : null}
    </div>;
  }
  let type = 'text'; let inputProps = { id, name: id, disabled, value: value ?? '', onChange: (event) => onChange(event.target.value), maxLength: 16000 };
  if (control.type === 'select') {
    const searchable = control.multiple || field.fieldType === 'lookup';
    type = searchable ? 'searchable-select' : 'dropdown';
    inputProps = { id, name: id, disabled, value: control.multiple ? Array.isArray(value) ? value : [] : value ?? '',
      options: control.options, placeholder: `Select ${field.label}`,
      ...(searchable ? { multiple: control.multiple, clearable: !control.required, invalid: Boolean(error), onChange,
        preparedOptions: field.fieldType === 'lookup' ? lookupSelectOptions : undefined, windowedOptions: field.fieldType === 'lookup' }
        : { onChange: (event) => onChange(event.target.value) }) };
  } else if (control.type === 'relation') {
    type = 'searchable-select';
    inputProps = { id, name: id, disabled, value: Array.isArray(value) ? value : [], multiple: true, clearable: !control.required,
      options: userOptions, defaultOptions: defaultUserOptions ?? userOptions, loadOptions: loadUsers, cacheOptions: false,
      ...(kind === 'user' ? { bulkActionScope: 'visible' } : {}),
      placeholder: `Select ${field.label}`, invalid: Boolean(error), onChange };
  } else if (control.type === 'textarea') { type = 'textarea'; inputProps.rows = 3; }
  else {
    inputProps.type = control.type;
    if (control.type === 'date') { type = 'date'; delete inputProps.type; delete inputProps.maxLength; inputProps.value = customFieldDateInput(value, field); }
    if (control.type === 'datetime-local') inputProps.value = customFieldDateTimeInput(value, field);
  }
  return <div className="mb-3"><FormElement type={type} label={field.label} mandatory={control.required} message={error} messageTone="error" inputProps={inputProps} /></div>;
}

export default function MasterCustomFields({ kind, fields, loading, loadError, values, storedFields = [], lookupSources, errors, disabled, generatingId, onChange, onBusy, onGenerate, onReload }) {
  const resource = kind === 'parameter' ? 'test-parameters' : 'products';
  const requests = useRef(new Map()); const controllers = useRef(new Set());
  const [users, setUsers] = useState([]); const [userError, setUserError] = useState(''); const [moreUsers, setMoreUsers] = useState(false);
  const storedByKey = useMemo(() => new Map(storedFields.map((field) => [field.key, field])), [storedFields]);
  const selectedUsers = useMemo(() => storedFields.flatMap((field) => field.items.filter((item) => item.userId).map((item) => userOption(item.userId, item.userName))), [storedFields]);
  const userOptions = useMemo(() => [...new Map([...selectedUsers, ...users].map((option) => [option.value, option])).values()], [selectedUsers, users]);
  const hasUsers = fields.some((field) => field.fieldType === 'multi_user_select');
  const loadUsers = useCallback((search) => {
    if (requests.current.has(search)) return requests.current.get(search);
    const abort = new AbortController(); controllers.current.add(abort);
    const pending = apiRequest(`/api/masters/${resource}/custom-field-users?search=${encodeURIComponent(search)}`, { signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return [];
        const options = result.rows.map((row) => userOption(row.id, row.name));
        setUsers((current) => [...new Map([...current, ...options].map((option) => [option.value, option])).values()]);
        setUserError(''); setMoreUsers(result.hasMore); return options;
      }).catch((failure) => { if (!abort.signal.aborted) setUserError(failure.message); return []; })
      .finally(() => { controllers.current.delete(abort); requests.current.delete(search); });
    requests.current.set(search, pending); return pending;
  }, [resource]);
  useEffect(() => {
    if (hasUsers) void loadUsers('');
    const active = controllers.current; const pending = requests.current;
    return () => { for (const abort of active) abort.abort(); pending.clear(); };
  }, [hasUsers, loadUsers]);
  if (loading) return <div className="mt-4 pt-3 border-top"><div className="text-muted small" role="status">Loading additional data fields...</div></div>;
  const failure = loadError ? <div className="alert alert-danger mt-4" role="alert">{loadError}<button type="button" className="btn btn-link" disabled={disabled} onClick={onReload}>Retry loading fields</button></div> : null;
  if (!fields.length) return failure;
  return <>{failure}<Profiler id={`${kind}-custom-fields`} onRender={(_id, phase, duration, _base, start) => performance.measure(`${kind}-fields:react-${phase}`, { start, duration })}>
    <div className="mt-4 pt-3 border-top"><div className="text-muted small fw-semibold mb-3 text-uppercase">Additional Data Fields</div>
    {fields.map((field) => {
      const source = lookupSources?.get(field.lookupSourceId);
      const content = <CustomFieldControl kind={kind} field={field} value={values[field.id]} stored={storedByKey.get(field.key)} disabled={disabled} error={errors[field.id]}
        lookupOptions={source?.options} lookupSelectOptions={source?.selectOptions}
        onChange={(value) => onChange(field.id, value)} onBusy={onBusy} userOptions={userOptions} loadUsers={loadUsers} />;
      return <div key={field.fieldType === 'attachment' ? `attachment:${field.key}` : field.id}>{field.scheme || field.fieldType === 'attachment' ? <div className="d-flex align-items-end gap-3"><div className="flex-fill min-w-0">{content}</div>
        {field.scheme ? <button type="button" className="smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center justify-content-center flex-shrink-0"
          title="Generate value from scheme" aria-label={`Generate ${field.label} value from scheme`} disabled={disabled || Boolean(generatingId)} onClick={() => onGenerate(field)}>
          {generatingId === field.id ? <span className="spinner-border spinner-border-sm" aria-hidden="true" /> : <AppIcon name="refresh" size={14} />}
        </button> : null}</div> : content}</div>;
    })}
    {hasUsers && moreUsers ? <div className="smplfy-form-text form-text">More users match. Refine your search to find a user.</div> : null}
    {hasUsers && userError ? <div className="smplfy-form-element__message smplfy-form-element__message--error" role="alert">{userError}</div> : null}
    </div>
  </Profiler></>;
}
