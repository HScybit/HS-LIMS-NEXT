'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { visibleRoleCapabilities } from '../../roles/capabilities.js';
import { useRoleSettings } from './useRoleSettings.js';

export default function RoleForm({ role }) {
  const router = useRouter(); const search = useSearchParams(); const newId = useRef(null); const saveRequest = useRef(null);
  const { settings, error: settingsError, retry } = useRoleSettings();
  const [draft, setDraft] = useState(() => ({ name: role?.name ?? '', description: role?.description ?? '', defaultPath: role?.defaultPath ?? '',
    capabilityKeys: role?.protected ? [...new Set([...role.capabilityKeys, 'can_admin'])] : role?.capabilityKeys ?? [] }));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [nameError, setNameError] = useState('');
  const from = search.get('from'); const returnPath = from && /^\/(?:role_management|administration\/roles)(?:\?[^#]*)?$/.test(from) ? from : '/role_management';
  const change = (key) => (event) => { const value = event.target.value; setDraft((current) => ({ ...current, [key]: value })); if (key === 'name') setNameError(''); };
  function toggle(key, selected) {
    setDraft((current) => ({ ...current, capabilityKeys: selected ? [...current.capabilityKeys, key] : current.capabilityKeys.filter((value) => value !== key) }));
  }
  async function save(event) {
    event.preventDefault(); if (saving || !settings || settingsError) return;
    if (!draft.name.trim()) { setNameError('Name is required.'); return; }
    setSaving(true); setError(''); newId.current ??= crypto.randomUUID();
    const body = { name: draft.name.trim(), description: draft.description.trim(), defaultPath: draft.defaultPath.trim() || null,
      capabilityKeys: [...draft.capabilityKeys].sort(), revision: role?.revision ?? 0, ...(!role ? { id: newId.current } : {}) };
    // Hidden API permissions are deliberately omitted on edit, so the command retains their exact current set.
    const content = JSON.stringify(body);
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() };
    try {
      await apiRequest(role ? `/api/roles/${role.id}` : '/api/roles', { method: role ? 'PATCH' : 'POST', body: { ...body, requestId: saveRequest.current.id } });
      notifySessionChange(); router.push(returnPath); router.refresh();
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9">
    <div className="card border-0 shadow-sm"><div className="card-body p-4">
      <form onSubmit={save} noValidate>
        {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
        {settingsError ? <div className="alert alert-danger" role="alert">{settingsError}<button type="button" className="btn btn-link" onClick={retry}>Retry loading settings</button></div> : null}
        {[
          ['name', 'Name', 'Add name of the role', 150], ['description', 'Description', 'Add Description of the role', 2000],
          ['defaultPath', 'Default Url', 'Add Default Url of the role', 300],
        ].map(([key, label, placeholder, maxLength]) => <div className="mb-3" key={key}><FormElement label={label} mandatory={key === 'name'}
          message={key === 'name' ? nameError : ''} messageTone="error"
          inputProps={{ name: key, value: draft[key], placeholder, maxLength, disabled: saving, onChange: change(key) }} /></div>)}
        {!settings && !settingsError ? <p className="text-muted" role="status">Loading role settings...</p> : null}
        {settings ? visibleRoleCapabilities(settings).map((capability) => <div className="mb-3" key={capability.key}><div className="smplfy-checkbox-field">
          <Checkbox id={capability.key} ariaLabel={capability.label} checked={draft.capabilityKeys.includes(capability.key)} disabled={saving || Boolean(settingsError)}
            onChange={(selected) => toggle(capability.key, selected)} />
          <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={capability.key}>{capability.label}</label></div>
        </div></div>) : null}
        <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>
          <PrimaryButton type="submit" leftIcon="save" disabled={saving || !settings || Boolean(settingsError)}>{saving ? 'Saving...' : role ? 'Update' : 'Create'}</PrimaryButton></div>
      </form>
    </div></div>
  </div></div></div>;
}
