'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import InputFieldText from '../ui/InputFieldText.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';

function getUserName(user) {
  return (
    user?.profile?.name ||
    [user?.profile?.first_name, user?.profile?.last_name].filter(Boolean).join(' ') ||
    user?.profile?.username ||
    user?.username ||
    'User'
  );
}

function getUserEmail(user) {
  return user?.profile?.email || user?.emails?.[0]?.address || '';
}

function getUserInitials(user) {
  const name = getUserName(user);
  const parts = String(name || '').split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
    : String(parts[0] || 'U').slice(0, 2).toUpperCase();
}

function getDisplayValue(value) {
  const normalized = String(value || '').trim();
  return normalized || 'Not set';
}

function InlineNotice({ tone = 'info', children }) {
  if (!children) return null;

  const iconName = tone === 'error'
    ? 'alert-circle'
    : tone === 'success'
      ? 'check'
      : 'settings';

  return (
    <div className={`smplfy-me-notice smplfy-me-notice--${tone}`}>
      <AppIcon name={iconName} />
      <span>{children}</span>
    </div>
  );
}

function FieldShell({ id, label, required = false, children, hint }) {
  return (
    <div className="smplfy-me-field">
      <label className="smplfy-me-field__label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true">*</span> : null}
      </label>
      {children}
      {hint ? <div className="smplfy-me-field__hint">{hint}</div> : null}
    </div>
  );
}

export default function Profile({ identity }) {
  const router = useRouter();
  const user = { username: identity.username, profile: { name: identity.displayName, email: identity.email, username: identity.username } };
  const currentProfile = user.profile;
  const [profileForm, setProfileForm] = useState({ name: identity.displayName, email: identity.email, username: identity.username });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [passwordForm, setPasswordForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const profileDirty = profileForm.name !== identity.displayName || profileForm.username !== identity.username;
  const accountStatus = 'Active';
  const profileSummary = [
    { label: 'Role', value: identity.roles.join(', ') },
    { label: 'Unit', value: '' }, { label: 'Designation', value: '' }, { label: 'Lab', value: '' },
  ];
  function updateProfileField(field, value) {
    setProfileForm((current) => ({ ...current, [field]: value }));
    setProfileError('');
  }
  function updatePasswordField(field, value) {
    setPasswordForm((current) => ({ ...current, [field]: value }));
    setPasswordError('');
  }
  async function handleProfileSubmit(event) {
    event.preventDefault();
    if (profileSaving) return;
    if (!profileForm.name.trim() || !profileForm.username.trim()) { setProfileError('Name and username are required.'); return; }
    setProfileSaving(true);
    setProfileError('');
    try {
      await apiRequest('/api/profile', { method: 'PATCH', body: { displayName: profileForm.name, username: profileForm.username, revision: identity.revision } });
      showToast('Profile updated.');
      notifySessionChange();
      router.refresh();
    } catch (error) { setProfileError(error.message); showToast(error.message, 'error'); }
    finally { setProfileSaving(false); }
  }
  async function handlePasswordSubmit(event) {
    event.preventDefault();
    if (passwordSaving) return;
    setPasswordSaving(true);
    setPasswordError('');
    try {
      await apiRequest('/api/profile/password', { method: 'POST', body: { currentPassword: passwordForm.oldPassword, newPassword: passwordForm.newPassword, confirmPassword: passwordForm.confirmPassword } });
      setPasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
      showToast('Password changed successfully.');
      notifySessionChange();
      router.refresh();
    } catch (error) { setPasswordError(error.message); showToast(error.message, 'error'); }
    finally { setPasswordSaving(false); }
  }

  return (
    <main className="smplfy-me-page">
      <div className="container-fluid">
        <section className="smplfy-me-hero" aria-labelledby="me-page-title">
          <div className="smplfy-me-identity">
            <div className="smplfy-me-avatar" aria-hidden="true">
              {getUserInitials(user)}
            </div>
            <div className="smplfy-me-heading">
              <span className="smplfy-me-kicker">My Account</span>
              <h1 id="me-page-title">{getUserName(user)}</h1>
              <div className="smplfy-me-subtitle">
                <span>{getDisplayValue(getUserEmail(user))}</span>
                <span aria-hidden="true">/</span>
                <span>{getDisplayValue(currentProfile.username || user.username)}</span>
              </div>
            </div>
          </div>

          <div className="smplfy-me-hero-actions">
            <span className={`smplfy-me-status smplfy-me-status--${accountStatus.toLowerCase()}`}>
              <AppIcon name={accountStatus === 'Active' ? 'check' : 'alert-circle'} />
              {accountStatus}
            </span>
            <SecondaryButton to={'/dashboard'} leftIcon="home">
              Dashboard
            </SecondaryButton>
          </div>
        </section>

        {identity.mustChangePassword ? <InlineNotice>Change your password before continuing.</InlineNotice> : null}
        <div className="smplfy-me-grid">
          <form className="smplfy-me-panel" onSubmit={handleProfileSubmit}>
            <div className="smplfy-me-panel__header">
              <span className="smplfy-me-panel__icon">
                <AppIcon name="user" />
              </span>
              <div>
                <h2>Profile Details</h2>
                <p>Name and employee identity used across LIMS.</p>
              </div>
            </div>

            <InlineNotice tone="error">{profileError}</InlineNotice>

            <div className="smplfy-me-fields">
              <FieldShell id="me-profile-name" label="Name" required>
                <InputFieldText
                  id="me-profile-name"
                  value={profileForm.name}
                  placeholder="John Doe"
                  autoComplete="name"
                  onChange={(event) => updateProfileField('name', event.target.value)}
                />
              </FieldShell>

              <FieldShell id="me-profile-email" label="Email">
                <InputFieldText
                  id="me-profile-email"
                  type="email"
                  value={profileForm.email}
                  disabled
                />
              </FieldShell>

              <FieldShell id="me-profile-username" label="Username/Employee ID" required>
                <InputFieldText
                  id="me-profile-username"
                  value={profileForm.username}
                  placeholder="Employee No"
                  autoComplete="username"
                  onChange={(event) => updateProfileField('username', event.target.value)}
                />
              </FieldShell>
            </div>

            <div className="smplfy-me-summary-grid">
              {profileSummary.map((item) => (
                <div className="smplfy-me-summary-item" key={item.label}>
                  <span>{item.label}</span>
                  <strong>{getDisplayValue(item.value)}</strong>
                </div>
              ))}
            </div>

            <div className="smplfy-me-panel__footer">
              <PrimaryButton
                type="submit"
                leftIcon="save"
                disabled={profileSaving || !profileDirty}
              >
                {profileSaving ? 'Saving...' : 'Update Profile'}
              </PrimaryButton>
            </div>
          </form>

          <form className="smplfy-me-panel" onSubmit={handlePasswordSubmit}>
            <div className="smplfy-me-panel__header">
              <span className="smplfy-me-panel__icon smplfy-me-panel__icon--warning">
                <AppIcon name="fa-user-shield" />
              </span>
              <div>
                <h2>Password</h2>
                <p>Change the password for your current sign-in.</p>
              </div>
            </div>

            <InlineNotice tone="error">{passwordError}</InlineNotice>

            <div className="smplfy-me-fields">
              <FieldShell id="me-old-password" label="Old Password" required>
                <InputFieldText
                  id="me-old-password"
                  type="password"
                  value={passwordForm.oldPassword}
                  autoComplete="current-password"
                  placeholder="Current password"
                  onChange={(event) => updatePasswordField('oldPassword', event.target.value)}
                />
              </FieldShell>

              <FieldShell id="me-new-password" label="New Password" required>
                <InputFieldText
                  id="me-new-password"
                  type="password"
                  value={passwordForm.newPassword}
                  autoComplete="new-password"
                  placeholder="New password"
                  onChange={(event) => updatePasswordField('newPassword', event.target.value)}
                />
              </FieldShell>

              <FieldShell id="me-confirm-password" label="New Password Confirmation" required>
                <InputFieldText
                  id="me-confirm-password"
                  type="password"
                  value={passwordForm.confirmPassword}
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  onChange={(event) => updatePasswordField('confirmPassword', event.target.value)}
                />
              </FieldShell>
            </div>

            <div className="smplfy-me-panel__footer">
              <PrimaryButton type="submit" leftIcon="save" disabled={passwordSaving}>
                {passwordSaving ? 'Changing...' : 'Change Password'}
              </PrimaryButton>
            </div>
          </form>

        </div>
      </div>
    </main>
  );
}
