'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormPage, { FormSection, FormField } from '../ui/FormPage.jsx';
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
  return <FormPage title={role ? 'Edit Role' : 'New Role'} backTo={returnPath} backLabel="Back to roles"
    formId="role-form" onSubmit={save} saving={saving} disabled={saving || !settings || Boolean(settingsError)}
    submitLabel={role ? 'Update' : 'Create'} error={error}
    actions={<SecondaryButton leftIcon="close" disabled={saving} onClick={() => router.push(returnPath)}>Cancel</SecondaryButton>}>
    {settingsError ? <div className="alert alert-danger" role="alert">{settingsError}<button type="button" className="btn btn-link" onClick={retry}>Retry loading settings</button></div> : null}
    <FormSection title="Role Details">
      {[
        ['name', 'Name', 'Add name of the role', 150, 6], ['defaultPath', 'Default Url', 'Add Default Url of the role', 300, 6],
        ['description', 'Description', 'Add Description of the role', 2000, 12],
      ].map(([key, label, placeholder, maxLength, span]) => <FormField span={span} key={key}><FormElement label={label} mandatory={key === 'name'}
        message={key === 'name' ? nameError : ''} messageTone="error"
        inputProps={{ name: key, value: draft[key], placeholder, maxLength, disabled: saving, onChange: change(key) }} /></FormField>)}
    </FormSection>

    <FormSection title="Capabilities" last>
      {!settings && !settingsError ? <FormField span={12}><p className="text-muted mb-0" role="status">Loading role settings...</p></FormField> : null}
      {settings ? visibleRoleCapabilities(settings).map((capability) => <FormField key={capability.key}>
        <div className="smplfy-checkbox-field">
          <Checkbox id={capability.key} ariaLabel={capability.label} checked={draft.capabilityKeys.includes(capability.key)} disabled={saving || Boolean(settingsError)}
            onChange={(selected) => toggle(capability.key, selected)} />
          <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={capability.key}>{capability.label}</label></div>
        </div>
      </FormField>) : null}
    </FormSection>
  </FormPage>;
}
