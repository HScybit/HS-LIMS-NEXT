'use client';

import { useState } from 'react';
import Link from 'next/link';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';

export default function ResetPassword({ token }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest('/api/auth/reset-password', { method: 'POST', body: { token, newPassword, confirmPassword } });
      notifySessionChange();
      setDone(true);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="auth-layout"><div className="auth-layout__content"><div className="auth-layout__panel"><div className="auth-layout__card"><div className="auth-layout__card-body">
    <div className="mb-4"><div className="auth-layout__eyebrow">Password Recovery</div><h1 className="auth-layout__heading">Reset password</h1><p className="auth-layout__subheading">{done ? 'Password changed successfully.' : 'Choose a new password for your Sampleify account.'}</p></div>
    {error ? <div className="auth-layout__error mb-4" role="alert">{error}</div> : null}
    {!done ? <form onSubmit={submit}>
      <div className="mb-4"><FormElement label="New Password" inputProps={{ id: 'new-password', type: 'password', autoComplete: 'new-password', value: newPassword, onChange: (event) => setNewPassword(event.target.value), required: true }} /></div>
      <div className="mb-4"><FormElement label="New Password Confirmation" inputProps={{ id: 'confirm-password', type: 'password', autoComplete: 'new-password', value: confirmPassword, onChange: (event) => setConfirmPassword(event.target.value), required: true }} /></div>
      <PrimaryButton type="submit" className="w-100" disabled={busy}>{busy ? 'Changing...' : 'Change Password'}</PrimaryButton>
    </form> : null}
    <Link href="/login" className="auth-layout__footer-link d-inline-block mt-3">Back to sign in</Link>
  </div></div></div></div></div>;
}
