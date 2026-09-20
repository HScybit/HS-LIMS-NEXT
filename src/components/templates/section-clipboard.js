// A container's clipboard entry is just enough to replay a pasteSection
// command later: which template version it came from and which section id.
// Scoped to this browser only (localStorage), matching the reference
// designer's own cross-template copy/paste — nothing is sent to the server
// until the user actually pastes.
const KEY = 'sampleify.template-designer.section-clipboard';

export function copySection({ versionId, sectionId, label }) {
  try { window.localStorage.setItem(KEY, JSON.stringify({ versionId, sectionId, label, copiedAt: Date.now() })); }
  catch { /* Private browsing or storage disabled — paste simply won't be available. */ }
}

export function readClipboard() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value?.versionId && value?.sectionId ? value : null;
  } catch { return null; }
}

export function clearClipboard() {
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}
