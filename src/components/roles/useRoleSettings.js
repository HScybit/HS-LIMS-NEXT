'use client';

import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api-client.js';

export function useRoleSettings() {
  const [settings, setSettings] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest('/api/roles/settings', { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) {
        setSettings((current) => current?.selfAllocationEnabled === value.selfAllocationEnabled ? current : value); setError('');
      }
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload((value) => value + 1); };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { settings, error, retry: () => setReload((value) => value + 1) };
}
