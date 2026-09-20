import { apiRequest } from '../lib/api-client.js';

function waitForPoll(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function prepareReportPrint(reportId, signal) {
  const path = `/api/reports/${reportId}/pdf`;
  let result = await apiRequest(path, { method: 'POST', signal });
  while (result.job && ['queued', 'running'].includes(result.job.status)) {
    await waitForPoll(signal);
    result = await apiRequest(path, { signal });
  }
  if (result.job?.status !== 'succeeded') throw new Error(result.job?.errorMessage || 'The PDF could not be prepared. Try regenerating the report.');
  const response = await fetch(`${path}/file`, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error?.message || 'The report PDF could not be loaded.');
  }
  if (response.headers.get('content-type') !== 'application/pdf') throw new Error('The report PDF could not be loaded.');
  return response.blob();
}

// The source Print action invokes the PDF print dialog in the current tab.
// The hidden frame survives long enough for that dialog to read its bytes.
export function printReportBlob(blob, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const frame = document.createElement('iframe');
    let settled = false; let printTimer; let expiryTimer;
    frame.title = 'Report PDF print frame'; frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    const cleanup = () => { clearTimeout(printTimer); clearTimeout(expiryTimer); frame.remove(); URL.revokeObjectURL(url); };
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (error) { cleanup(); reject(error); } else { expiryTimer = setTimeout(cleanup, 120_000); resolve(); }
    };
    const abort = () => finish(signal.reason);
    const deadline = setTimeout(() => finish(new Error('The browser could not open the print dialog. Try Print again.')), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    frame.onload = () => {
      printTimer = setTimeout(() => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); finish(); }
        catch { finish(new Error('The browser could not open the print dialog. Try Print again.')); }
      }, 350);
    };
    frame.onerror = () => finish(new Error('The PDF could not be opened for printing.'));
    frame.src = url; document.body.appendChild(frame);
  });
}
