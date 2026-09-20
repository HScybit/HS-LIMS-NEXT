'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { localRedirect } from '../../auth/tokens-client.js';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [requiresMfa, setRequiresMfa] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (loading) return;
    if (!email.trim() || !password) { setError('Username and password are required.'); return; }
    if (requiresMfa && !mfaCode.trim()) { setError('Please enter the MFA code from your authenticator app.'); return; }
    setLoading(true);
    setError(null);
    try {
      await apiRequest('/api/auth/login', { method: 'POST', body: { identifier: email, password, mfaCode } });
      const { identity } = await apiRequest('/api/auth/session');
      notifySessionChange();
      const target = identity.mustChangePassword ? '/me' : localRedirect(new URLSearchParams(window.location.search).get('redirect'));
      router.replace(target);
      router.refresh();
    } catch (failure) {
      setRequiresMfa(failure.code === 'mfa_required' || requiresMfa);
      setError(failure.message);
    } finally { setLoading(false); }
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    if (!resetEmail.trim() || resetLoading) return;
    setResetLoading(true);
    setError(null);
    try {
      await apiRequest('/api/auth/forgot-password', { method: 'POST', body: { email: resetEmail } });
      setResetSent(true);
    } catch (failure) { setError(failure.message); }
    finally { setResetLoading(false); }
  }

  return (
    <div className="auth-layout">
      <aside className="auth-layout__aside d-none d-md-flex">
        <img src="/images/dcpl.png" alt="Logo" className="auth-layout__brand-mark" />
        <div className="auth-layout__brand-copy">
          <h1>Sampleify LIMS</h1>
          <p>
            Digital R&D &amp; Laboratory<br />Information Management Suite
          </p>
        </div>
        <div className="auth-layout__feature-list">
          <div className="auth-layout__feature-item">
            <span className="auth-layout__feature-dot" aria-hidden="true" />
            End-to-end sample lifecycle tracking
          </div>
          <div className="auth-layout__feature-item">
            <span className="auth-layout__feature-dot" aria-hidden="true" />
            Real-time test request management
          </div>
          <div className="auth-layout__feature-item">
            <span className="auth-layout__feature-dot" aria-hidden="true" />
            Automated Test report generation
          </div>
        </div>
      </aside>

      <div className="auth-layout__content">
        <div className="auth-layout__panel">
          <div className="auth-layout__card">
            <div className="auth-layout__card-body">
              {!forgotOpen ? (
                <>
                  <div className="mb-4">
                    <div className="auth-layout__eyebrow">Welcome Back</div>
                    <h2 className="auth-layout__heading">Sign in</h2>
                    <p className="auth-layout__subheading">Use your Sampleify credentials to continue.</p>
                  </div>

                  {error ? (
                    <div className="auth-layout__error mb-4" role="alert">
                      <span className="auth-layout__error-icon" aria-hidden="true">
                        <AppIcon name="alert-circle" size={16} />
                      </span>
                      {error}
                    </div>
                  ) : null}

                  <form onSubmit={handleSubmit} noValidate>
                    <div className="mb-4">
                      <FormElement
                        type="text"
                        label="Username"
                        inputProps={{
                          id: 'login-email',
                          type: 'text',
                          value: email,
                          state: error ? 'error' : 'default',
                          onChange: (e) => setEmail(e.target.value),
                          placeholder: 'Enter your username',
                          autoComplete: 'username',
                          autoFocus: true,
                          required: true,
                        }}
                      />
                    </div>

                    <div className="mb-4">
                      <FormElement
                        type="text"
                        label="Password"
                        inputProps={{
                          id: 'login-password',
                          type: 'password',
                          value: password,
                          state: error ? 'error' : 'default',
                          onChange: (e) => setPassword(e.target.value),
                          placeholder: 'Enter your password',
                          autoComplete: 'current-password',
                          required: true,
                        }}
                      />
                    </div>

                    {requiresMfa ? (
                      <div className="mb-4">
                        <FormElement
                          type="text"
                          label="MFA Code"
                          helperText="Enter the code from your authenticator app."
                          inputProps={{
                            id: 'login-mfa-code',
                            type: 'text',
                            value: mfaCode,
                            state: error ? 'error' : 'default',
                            onChange: (e) => setMfaCode(e.target.value),
                            placeholder: 'Enter MFA code',
                            autoComplete: 'one-time-code',
                            inputMode: 'numeric',
                            required: true,
                          }}
                        />
                      </div>
                    ) : null}

                    <div className="d-flex align-items-center justify-content-between mb-4">
                      <div className="smplfy-checkbox-field smplfy-checkbox-field--inline">
                        <Checkbox checked={rememberMe} onChange={setRememberMe} ariaLabel="Remember me" />
                        <button
                          type="button"
                          className="smplfy-checkbox-field__label-button"
                          onClick={() => setRememberMe((current) => !current)}
                        >
                          Remember me
                        </button>
                      </div>
                      <button type="button" className="auth-layout__footer-link" onClick={() => { setError(null); setForgotOpen(true); }}>
                        Forgot password?
                      </button>
                    </div>

                    <PrimaryButton type="submit" className="w-100" disabled={loading}>
                      {loading ? (
                        <>
                          <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                          Signing in...
                        </>
                      ) : 'Sign in'}
                    </PrimaryButton>
                  </form>
                </>
              ) : (
                <>
                  <div className="mb-4">
                    <div className="auth-layout__eyebrow">Password Recovery</div>
                    <h2 className="auth-layout__heading">Reset password</h2>
                    <p className="auth-layout__subheading">
                      {resetSent
                        ? 'Check your inbox for a reset link.'
                        : "Enter your email and we'll send a reset link."}
                    </p>
                  </div>

                  {error ? <div className="auth-layout__error mb-4" role="alert">{error}</div> : null}
                  {!resetSent ? (
                    <form key="password-recovery" onSubmit={handleResetPassword} noValidate>
                      <div className="mb-4">
                        <FormElement
                          type="text"
                          label="Email address"
                          inputProps={{
                            id: 'reset-email',
                            type: 'email',
                            value: resetEmail,
                            onChange: (e) => setResetEmail(e.target.value),
                            placeholder: 'you@example.com',
                            autoFocus: true,
                            required: true,
                          }}
                        />
                      </div>
                      <PrimaryButton type="submit" className="w-100" disabled={resetLoading}>
                        {resetLoading ? (
                          <>
                            <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                            Sending...
                          </>
                        ) : 'Send reset link'}
                      </PrimaryButton>
                    </form>
                  ) : null}

                  <button
                    type="button"
                    className="auth-layout__footer-link text-secondary mt-3"
                    onClick={() => {
                      setForgotOpen(false);
                      setResetSent(false);
                      setResetLoading(false);
                      setResetEmail('');
                    }}
                  >
                    Back to sign in
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
