'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import UserReferenceField from './UserReferenceField.jsx';
import UserSignatureField from './UserSignatureField.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { userFormDraft, userFormErrors, userFormPayload, userReturnPath } from '../../users/form-model.js';
import { saveUserSignature } from '../../users/signature-client.js';

export default function UserForm({ data, canManage, currentUserId, onReload }) {
  const router = useRouter(); const search = useSearchParams(); const returnPath = userReturnPath(search.get('from'));
  const newId = useRef(null); const request = useRef(null); const createdUser = useRef(null); const upload = useRef(null);
  const [draft, setDraft] = useState(() => userFormDraft(data)); const [saving, setSaving] = useState(false); const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({}); const [unknown, setUnknown] = useState(false); const [created, setCreated] = useState(false);
  const [signatureFile, setSignatureFile] = useState(null); const [signaturePending, setSignaturePending] = useState(false);
  const blocked = !canManage || saving || unknown || created; const identityBlocked = blocked || data?.account.canEditIdentity === false;
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setFieldErrors(current => ({ ...current, [key]: '' })); };
  async function save(event) {
    event.preventDefault(); if (saving || !canManage || signaturePending) return;
    if (!unknown && !created) {
      const errors = userFormErrors(draft, Boolean(data)); setFieldErrors(errors); if (Object.keys(errors).length) return;
      newId.current ??= crypto.randomUUID();
      const content = JSON.stringify(userFormPayload(draft, data, { id: newId.current }));
      if (request.current?.content !== content) request.current = { content, body: { ...JSON.parse(content), requestId: crypto.randomUUID() } };
    }
    setSaving(true); setError(null);
    try {
      if (!createdUser.current) {
        const result = await apiRequest(data ? `/api/users/${data.user.id}` : '/api/users', { method: data ? 'PATCH' : 'POST', body: request.current.body });
        setUnknown(false);
        if (!data) { createdUser.current = result.user.id; setCreated(true); }
        if (data?.user.id === currentUserId && result.passwordChanged) { notifySessionChange(); router.replace('/login'); router.refresh(); return; }
      }
      if (!data && signatureFile) {
        upload.current ??= { file: signatureFile, requestId: crypto.randomUUID(), revision: 0 };
        await saveUserSignature(createdUser.current, upload.current);
      }
      notifySessionChange(); router.push(returnPath); router.refresh();
    } catch (failure) {
      setError(failure);
      if (!createdUser.current) setUnknown(![400, 401, 403, 404, 409, 413, 422].includes(failure.status));
    } finally { setSaving(false); }
  }
  function textField(key, label, placeholder, maxLength, type = 'text', required = false) {
    return <div className="mb-3"><FormElement label={label} mandatory={required} message={fieldErrors[key]} messageTone="error"
      helperText={key === 'password' ? 'Leave blank on edit to keep the existing password.' : undefined}
      inputProps={{ name: key, type, placeholder, maxLength, value: draft[key], disabled: ['displayName', 'email', 'username', 'password'].includes(key) ? identityBlocked : blocked,
        autoComplete: key === 'password' ? 'new-password' : undefined, onChange: event => change(key, event.target.value) }} /></div>;
  }
  return <div className="container-fluid py-4"><div className="row justify-content-center"><div className="col-xl-7 col-lg-9"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <form onSubmit={save} noValidate>
      {!canManage ? <div className="alert alert-warning" role="alert">You no longer have permission to manage users. Your unsaved entries are retained.</div> : null}
      {data?.account.canEditIdentity === false ? <div className="alert alert-info">This user’s name, sign-in details and password can be changed by the account owner or a platform administrator.</div> : null}
      {error ? <div className="alert alert-danger" role="alert">{created ? 'The user was created, but the signature upload did not finish. ' : ''}{error.message}
        {unknown ? <div>Retry the same save to confirm its result. Your entries are retained.</div> : null}
        {error.code?.startsWith('stale_user_') && onReload ? <button type="button" className="btn btn-link" disabled={saving} onClick={onReload}>Reload saved user</button> : null}
      </div> : null}
      {textField('displayName', 'Name', 'John Doe', 200, 'text', true)}
      {textField('email', 'Email', 'employee@company.com', 320, 'email', true)}
      {textField('phone', 'Contact Number', 'Please enter 12 digit phone number', 50)}
      {textField('username', 'Username/Employee ID', 'Employee No or something...', 100, 'text', true)}
      {textField('password', 'Password', 'A secure password...', 200, 'password', !data)}
      <div className="mb-3 smplfy-checkbox-field"><Checkbox id="user-can-manage-people" checked={draft.canManagePeople} disabled={blocked} onChange={value => change('canManagePeople', value)} />
        <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="user-can-manage-people">Can be Manager?</label>
          <div className="form-text">Can the user be a manager of any project?</div></div></div>
      {textField('designation', 'Designation', 'Designation', 150)}
      {[
        ['businessUnitId', 'businessUnits', 'Unit', 'Select Unit', data?.profile.businessUnitName, false],
        ['defaultRoleId', 'roles', 'Default Role', 'Select Role', data?.user.defaultRoleName, true],
        ['laboratoryId', 'laboratories', 'Lab', 'Select Lab', data?.profile.laboratoryName, true],
        ...(data ? [['reportingManagerId', 'managers', 'Reporting Manager', 'Select Reporting Manager', data.profile.reportingManagerName, false]] : []),
      ].map(([key, kind, label, placeholder, savedLabel, required]) => <UserReferenceField key={key} kind={kind} label={label} placeholder={placeholder} value={draft[key]} savedLabel={savedLabel}
        onChange={value => change(key, value)} disabled={blocked} required={required} error={fieldErrors[key]} excludeUserId={data?.user.id} />)}
      <UserSignatureField userId={data?.user.id} signature={data?.signature} selectedFile={signatureFile} onSelect={setSignatureFile} disabled={blocked}
        onPendingChange={setSignaturePending} />
      <div className="d-flex gap-2 justify-content-end mt-4"><SecondaryButton leftIcon="close" disabled={saving}
        onClick={() => router.push(created ? `/user_management/${createdUser.current}/edit` : returnPath)}>{created ? 'Open saved user' : 'Cancel'}</SecondaryButton>
        <PrimaryButton type="submit" leftIcon="save" disabled={saving || !canManage || signaturePending}>{saving ? 'Saving…' : created ? 'Retry signature upload' : unknown ? 'Retry save' : data ? 'Update' : 'Create'}</PrimaryButton></div>
    </form>
  </div></div></div></div></div>;
}
