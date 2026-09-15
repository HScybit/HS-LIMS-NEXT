'use client';

import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CustomFieldControl } from '../masters/MasterCustomFields.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { userFieldUserOption } from '../../users/custom-field-options.js';
import { userCustomFieldName, userCustomFieldSelectedIds, userCustomFieldSelectedOptions } from '../../users/custom-field-form.js';

export default function UserCustomFields({ fields, values, storedFields, lookupSources, loading, loadError, errors, disabled, refreshKey, onChange, onBusy, onReload }) {
  const searchRequest = useRef(null);
  const [defaultUsers, setDefaultUsers] = useState([]); const [choicesError, setChoicesError] = useState('');
  const [users, setUsers] = useState([]); const [selected, setSelected] = useState({ rows: [], ids: [] });
  const [userError, setUserError] = useState(''); const [labelError, setLabelError] = useState(''); const [moreUsers, setMoreUsers] = useState(false);
  const [choicesLoadedKey, setChoicesLoadedKey] = useState(null); const [labelsLoadedKey, setLabelsLoadedKey] = useState(null);
  const hasUsers = fields.some(field => field.fieldType === 'multi_user_select');
  const selectedIdsKey = JSON.stringify(userCustomFieldSelectedIds(fields, values));
  const labelLoadKey = JSON.stringify([refreshKey, selectedIdsKey]);
  const choicesLoading = hasUsers && !disabled && choicesLoadedKey === null;
  const labelsLoading = hasUsers && !disabled && labelsLoadedKey !== labelLoadKey;
  const resolvedIds = useMemo(() => new Set(selected.ids), [selected.ids]);
  const storedByKey = useMemo(() => new Map(storedFields.map(field => [field.key, field])), [storedFields]);
  const userOptions = useMemo(() => [...new Map([
    ...[...defaultUsers, ...users].filter(option => !resolvedIds.has(option.value.toLowerCase())),
    ...userCustomFieldSelectedOptions(fields, values, selected.rows),
  ].map(option => [option.value, option])).values()], [defaultUsers, users, selected.rows, resolvedIds, fields, values]);
  const loadUsers = useCallback(search => {
    searchRequest.current?.abort(); const controller = new AbortController(); searchRequest.current = controller;
    return apiRequest(`/api/users/custom-fields/user-options?search=${encodeURIComponent(search)}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return [];
        const options = result.rows.map(row => userFieldUserOption(row.id, row.name));
        setUsers(options); setUserError(''); return options;
      }).catch(failure => { if (!controller.signal.aborted) setUserError(failure.message); return []; });
  }, []);
  useEffect(() => {
    if (!hasUsers || disabled) return undefined;
    const controller = new AbortController();
    apiRequest('/api/users/custom-fields/user-options?search=', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setDefaultUsers(result.rows.map(row => userFieldUserOption(row.id, row.name))); setMoreUsers(result.hasMore); setChoicesError(''); }
    }).catch(failure => { if (!controller.signal.aborted) setChoicesError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setChoicesLoadedKey(refreshKey); });
    return () => controller.abort();
  }, [hasUsers, disabled, refreshKey]);
  useEffect(() => () => searchRequest.current?.abort(), [hasUsers, disabled]);
  useEffect(() => {
    if (!hasUsers || disabled) return undefined;
    const controller = new AbortController(); const ids = JSON.parse(selectedIdsKey);
    const result = ids.length ? apiRequest('/api/users/custom-fields/user-labels', { method: 'POST', signal: controller.signal, body: { ids } }) : Promise.resolve({ rows: [] });
    result.then(({ rows }) => {
      if (!controller.signal.aborted) { setSelected({ rows, ids }); setLabelError(''); }
    }).catch(failure => { if (!controller.signal.aborted) setLabelError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLabelsLoadedKey(labelLoadKey); });
    return () => controller.abort();
  }, [hasUsers, disabled, refreshKey, selectedIdsKey, labelLoadKey]);
  if (loading) return <div className="mt-4 pt-3 border-top"><div className="text-muted small" role="status">Loading additional data fields...</div></div>;
  const metadataError = loadError ? <div className="alert alert-danger mt-4" role="alert">{loadError}<button type="button" className="btn btn-link" disabled={disabled} onClick={onReload}>Retry loading fields</button></div> : null;
  if (!fields.length) return metadataError;
  return <Profiler id="user-custom-fields" onRender={(_id, phase, duration, _base, start) => performance.measure(`user-fields:react-${phase}`, { start, duration })}>
    <div className="mt-4 pt-3 border-top">{metadataError}<div className="text-muted small fw-semibold mb-3 text-uppercase">Additional Data Fields</div>
      {fields.map(field => {
        const name = userCustomFieldName(field);
        const content = <CustomFieldControl kind="user" field={field} value={values[name]} stored={storedByKey.get(field.key)} error={errors[name]}
          disabled={disabled || Boolean(loadError) || field.fieldType === 'multi_user_select' && choicesLoading}
          onChange={value => onChange(name, value)} onBusy={onBusy} userOptions={userOptions} defaultUserOptions={defaultUsers} loadUsers={loadUsers}
          lookupOptions={lookupSources?.get(field.lookupSourceId)?.options} lookupSelectOptions={lookupSources?.get(field.lookupSourceId)?.selectOptions} />;
        return <div key={name}>{field.scheme ? <div className="d-flex align-items-end gap-3"><div className="flex-fill min-w-0">{content}</div>
          <button type="button" className="smplfy-btn btn btn-outline-secondary btn-sm d-inline-flex align-items-center justify-content-center flex-shrink-0" disabled
            title="Value generation is currently unavailable" aria-label={`Generate ${field.label} value from scheme`}><AppIcon name="refresh" size={14} /></button>
        </div> : content}</div>;
      })}
      {hasUsers && moreUsers ? <div className="smplfy-form-text form-text">More users are available. Use search to find a user.</div> : null}
      {hasUsers && labelsLoading ? <div className="text-muted small" role="status">Loading selected users...</div> : null}
      {hasUsers && (choicesError || labelError) ? <div className="smplfy-form-element__message smplfy-form-element__message--error" role="alert">
        {choicesError || labelError}<button type="button" className="btn btn-link btn-sm" disabled={disabled} onClick={onReload}>Retry loading users</button>
      </div> : null}
      {hasUsers && userError ? <div className="smplfy-form-element__message smplfy-form-element__message--error" role="alert">{userError} Try searching again.</div> : null}
    </div>
  </Profiler>;
}
