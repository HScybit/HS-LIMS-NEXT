'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import InputFieldText from '../ui/InputFieldText.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import Modal from '../ui/Modal.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';

function SecurityStat({ icon, label, value, tone = 'neutral' }) {
  return <div className={`smplfy-me-security-stat smplfy-me-security-stat--${tone}`}>
    <span className="smplfy-me-security-stat__icon"><AppIcon name={icon} /></span>
    <span><span className="smplfy-me-security-stat__label">{label}</span><strong>{value}</strong></span>
  </div>;
}

async function mfaRequest(path, options) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await apiRequest(path, options); }
    catch (error) {
      // The same setup/change identity makes one lost-response retry safe.
      if (attempt === 1 || error.name === 'AbortError' || (error.status && error.status < 500)) throw error;
    }
  }
}

export default function MfaSettings({ identity }) {
  const router = useRouter();
  const [state, setState] = useState({ enabled: identity.mfaEnabled, revision: null, checking: true, busy: false, setup: null, code: '', error: '' });
  const [disableRequest, setDisableRequest] = useState(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const statusRequest = useRef(null);
  const reloadStatus = useRef(null);

  useEffect(() => {
    mounted.current = true;
    async function refresh() {
      if (busy.current || document.visibilityState === 'hidden') return;
      statusRequest.current?.abort();
      const controller = new AbortController();
      statusRequest.current = controller;
      try {
        const status = await apiRequest('/api/profile/mfa', { signal: controller.signal });
        if (!mounted.current || controller.signal.aborted) return;
        setState((current) => ({ ...current, ...status, checking: false, error: '',
          setup: !status.enabled && status.revision === current.revision ? current.setup : null,
          code: !status.enabled && status.revision === current.revision ? current.code : '' }));
      } catch (error) {
        if (mounted.current && !controller.signal.aborted) setState((current) => ({ ...current, checking: false, error: error.message,
          ...(error.status === 401 ? { setup: null, code: '', revision: null } : {}) }));
      }
    }
    reloadStatus.current = refresh;
    void refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('sampleify_session') : null;
    if (channel) channel.onmessage = refresh;
    return () => {
      mounted.current = false;
      reloadStatus.current = null;
      statusRequest.current?.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      channel?.close();
    };
  }, [identity.userId]);

  useEffect(() => {
    if (!state.setup) return undefined;
    const setupId = state.setup.setupId;
    const timer = window.setTimeout(() => {
      setState((current) => current.setup?.setupId === setupId
        ? { ...current, setup: null, code: '', error: 'MFA setup expired. Turn on Enable MFA to start again.' } : current);
    }, Math.max(0, new Date(state.setup.expiresAt).getTime() - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.setup]);

  async function perform(work, complete) {
    if (busy.current) return;
    busy.current = true;
    statusRequest.current?.abort();
    setState((current) => ({ ...current, busy: true, error: '' }));
    try {
      const result = await work();
      if (mounted.current) complete(result);
    } catch (error) {
      if (!mounted.current) return;
      if (['stale_mfa', 'mfa_enabled', 'mfa_setup_required'].includes(error.code)) {
        try {
          const status = await apiRequest('/api/profile/mfa');
          if (mounted.current) {
            setState((current) => ({ ...current, ...status, setup: null, code: '' }));
            setDisableRequest(null);
          }
        } catch { /* Keep the original actionable error if status refresh also fails. */ }
      }
      if (mounted.current) {
        setState((current) => ({ ...current, error: error.message,
          ...(error.status === 401 ? { setup: null, code: '', revision: null } : {}) }));
        showToast(error.message, 'error');
      }
    } finally {
      busy.current = false;
      if (mounted.current) setState((current) => ({ ...current, busy: false }));
    }
  }

  function changed(status) {
    setState((current) => ({ ...current, ...status, setup: null, code: '', error: '' }));
    showToast(status.enabled ? 'MFA enabled.' : 'MFA disabled.');
    notifySessionChange();
    router.refresh();
  }

  function toggle(event) {
    if (event.target.checked) {
      void perform(() => mfaRequest('/api/profile/mfa/setup', { method: 'POST', body: {} }),
        (setup) => setState((current) => ({ ...current, setup, revision: setup.revision, code: '' })));
    } else if (state.setup && !state.enabled) {
      void perform(() => mfaRequest('/api/profile/mfa/setup', { method: 'DELETE', body: { setupId: state.setup.setupId } }),
        () => setState((current) => ({ ...current, setup: null, code: '' })));
    } else {
      setDisableRequest({ revision: state.revision, requestId: crypto.randomUUID() });
    }
  }

  function verify(event) {
    event.preventDefault();
    if (!state.setup || busy.current) return;
    if (!/^\d{6}$/.test(state.code.trim())) {
      setState((current) => ({ ...current, error: 'Enter the six-digit authenticator code.' }));
      return;
    }
    void perform(() => mfaRequest('/api/profile/mfa/enable', { method: 'POST', body: { setupId: state.setup.setupId, code: state.code.trim() } }), changed);
  }

  async function copySecret() {
    try { await navigator.clipboard.writeText(state.setup.secret); showToast('Setup key copied.'); }
    catch { showToast('Could not copy the setup key. Select and copy it manually.', 'error'); }
  }

  return <section className="smplfy-me-panel smplfy-me-panel--wide" aria-labelledby="me-mfa-title">
    <div className="smplfy-me-panel__header">
      <span className="smplfy-me-panel__icon smplfy-me-panel__icon--success"><AppIcon name="qrcode" /></span>
      <div><h2 id="me-mfa-title">Multi-Factor Authentication</h2><p>Authenticator code verification for sign-in.</p></div>
    </div>
    <div className="smplfy-me-security-row">
      <SecurityStat icon={state.enabled ? 'check' : 'alert-circle'} label="MFA"
        value={state.checking ? 'Checking...' : state.enabled ? 'Enabled' : 'Disabled'} tone={state.enabled ? 'success' : 'warning'} />
      <SecurityStat icon="email" label="Email" value={identity.email || 'Not set'} />
    </div>
    <label className="smplfy-me-switch">
      <input type="checkbox" checked={state.enabled || Boolean(state.setup)} disabled={state.checking || state.busy || state.revision === null} onChange={toggle} />
      <span className="smplfy-me-switch__track" aria-hidden="true"><span /></span>
      <span>{state.enabled ? 'MFA enabled' : 'Enable MFA'}</span>
    </label>
    {state.error ? <div className="smplfy-me-notice smplfy-me-notice--error" role="alert"><AppIcon name="alert-circle" /><span>{state.error}</span>
      {state.revision === null ? <SecondaryButton size="small" onClick={() => reloadStatus.current?.()}>Retry</SecondaryButton> : null}
    </div> : null}
    {state.setup ? <form className="smplfy-me-mfa-setup" onSubmit={verify}>
      {/* The QR is a transient local PNG data URL; it must not go through an image cache. */}
      <div className="smplfy-me-qr" aria-label="MFA QR code"><img src={state.setup.qrDataUrl} alt="MFA QR code" /></div>
      <div className="smplfy-me-mfa-code">
        <div className="smplfy-me-mfa-manual"><span>Setup key</span>
          <div className="smplfy-me-mfa-secret"><code>{state.setup.secret}</code>
            <SecondaryButton leftIcon="fa-copy" size="small" aria-label="Copy setup key" onClick={copySecret} />
          </div>
        </div>
        <div className="smplfy-me-field">
          <label className="smplfy-me-field__label" htmlFor="me-mfa-code">Authenticator Code<span aria-hidden="true">*</span></label>
          <InputFieldText id="me-mfa-code" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6}
            value={state.code} onChange={(event) => setState((current) => ({ ...current, code: event.target.value, error: '' }))} />
        </div>
        <PrimaryButton type="submit" leftIcon="check" disabled={state.busy}>{state.busy ? 'Verifying...' : 'Submit Code'}</PrimaryButton>
      </div>
    </form> : null}
    <Modal open={Boolean(disableRequest)} title="Disable MFA?" titleIcon="alert-circle" size="small"
      onClose={() => { if (!busy.current) setDisableRequest(null); }}
      actions={<><SecondaryButton onClick={() => setDisableRequest(null)} disabled={state.busy}>Cancel</SecondaryButton>
        <PrimaryButton styleVariant="danger" disabled={state.busy} onClick={() => {
          void perform(() => mfaRequest('/api/profile/mfa', { method: 'DELETE', body: disableRequest }),
            (status) => { setDisableRequest(null); changed(status); });
        }}>{state.busy ? 'Disabling...' : 'Disable MFA'}</PrimaryButton></>}>
      <p>Your next sign-in will only require your password.</p>
      {state.error ? <div className="smplfy-me-notice smplfy-me-notice--error" role="alert">{state.error}</div> : null}
    </Modal>
  </section>;
}
