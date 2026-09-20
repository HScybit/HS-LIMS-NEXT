'use client';

// Live collaboration: notifies the designer when another session changes the same template
// version, so it can refresh instead of silently going stale. Returns an unsubscribe function.
export function subscribeToTemplateEvents(onEvent) {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {};
  const source = new EventSource('/api/template-designer-events');
  source.onmessage = (event) => {
    try { onEvent(JSON.parse(event.data)); } catch { /* malformed frame, ignore */ }
  };
  return () => source.close();
}
