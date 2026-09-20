'use client';

import { useEffect } from 'react';
import { apiRequest } from '../../lib/api-client.js';

export function notifyCustomCssChanged() {
  window.dispatchEvent(new Event('sampleify-custom-css-updated'));
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel('sampleify_custom_css'); channel.postMessage('changed'); channel.close();
  }
}

export default function CustomCssInjector({ enabled, organizationId }) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); const style = document.createElement('style');
    style.id = 'sampleify-organization-custom-css'; document.head.appendChild(style);
    let pending = false; let requested = false;
    async function refresh() {
      if (document.visibilityState === 'hidden') return;
      if (pending) { requested = true; return; }
      pending = true;
      try {
        const current = await apiRequest('/api/report-assets/custom-css/current', { signal: controller.signal });
        if (!controller.signal.aborted) { style.textContent = current.cssContent; style.dataset.versionId = current.versionId ?? ''; }
      } catch (error) {
        if (error.status === 401 || error.status === 403) style.textContent = '';
        // A transient failure retains the last successfully loaded stylesheet.
        // Focus, save events and the next refresh retry the read.
      } finally {
        pending = false;
        if (requested && !controller.signal.aborted) { requested = false; void refresh(); }
      }
    }
    const interval = window.setInterval(refresh, 20_000);
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('sampleify_custom_css') : null;
    if (channel) channel.onmessage = refresh;
    window.addEventListener('sampleify-custom-css-updated', refresh); window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh); void refresh();
    return () => {
      controller.abort(); style.remove(); window.clearInterval(interval); channel?.close();
      window.removeEventListener('sampleify-custom-css-updated', refresh); window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled, organizationId]);
  return null;
}
