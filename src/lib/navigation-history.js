const marker = 'sampleifyNavigation';

// Record positions without changing the router's own history state. A traversal
// is restored before awaiting a save, so the active editor stays mounted on failure.
export function installHistoryGuard(browser, { hasPending, prepareLeave }) {
  const history = browser.history;
  const scope = browser.crypto.randomUUID();
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  const nativePosition = () => browser.navigation?.currentEntry?.index;
  let position = nativePosition() ?? 0;
  let currentUrl = browser.location.href;
  let currentState = history.state;
  let pending = null;
  let replayPosition = null;
  let active = true;
  const marked = (state, index) => ({ ...state, [marker]: { scope, index } });
  function positionOf(state) {
    const native = nativePosition();
    if (Number.isSafeInteger(native) && native >= 0) return native;
    const value = state?.[marker];
    return value?.scope === scope && Number.isSafeInteger(value.index) ? value.index : null;
  }
  function remember(index) {
    position = index; currentUrl = browser.location.href; currentState = history.state;
  }
  function pushState(state, title, url) {
    originalPush(marked(state, position + 1), title, url);
    remember(positionOf(history.state) ?? position + 1);
  }
  function replaceState(state, title, url) {
    originalReplace(marked(state, position), title, url);
    remember(positionOf(history.state) ?? position);
  }
  history.pushState = pushState;
  history.replaceState = replaceState;
  replaceState(history.state, '', currentUrl);

  function finishTraversal(attempt) {
    if (!active || pending !== attempt || positionOf(history.state) !== position || !Object.hasOwn(attempt, 'allowed')) return;
    pending = null;
    if (attempt.allowed) { replayPosition = attempt.destination; history.go(attempt.destination - position); }
  }
  function popState(event) {
    const destination = positionOf(event.state);
    if (destination === null) {
      if (!hasPending()) { currentUrl = browser.location.href; currentState = history.state; return; }
      // An unmarked same-document entry from outside the router has no reliable
      // traversal distance. Preserve the editor and use a full navigation after saving.
      event.stopImmediatePropagation();
      const targetUrl = browser.location.href;
      originalReplace(currentState, '', currentUrl);
      void Promise.resolve(prepareLeave()).then((allowed) => {
        if (active && allowed) browser.location.assign(targetUrl);
      }).catch(() => {});
      return;
    }
    if (pending) {
      event.stopImmediatePropagation();
      if (destination !== position) { history.go(position - destination); return; }
      if (pending.saving) { finishTraversal(pending); return; }
      const attempt = pending; attempt.saving = true;
      void Promise.resolve(prepareLeave()).then((allowed) => {
        attempt.allowed = allowed; finishTraversal(attempt);
      }).catch(() => { attempt.allowed = false; finishTraversal(attempt); });
      return;
    }
    if (destination === replayPosition) {
      replayPosition = null;
      if (!hasPending()) { remember(destination); return; }
    }
    if (hasPending() && destination !== position) {
      event.stopImmediatePropagation();
      pending = { destination, saving: false };
      history.go(position - destination);
      return;
    }
    replayPosition = null; remember(destination);
    // Also label native fragment entries for browsers without Navigation API.
    originalReplace(marked(history.state, position), '', currentUrl);
  }
  browser.addEventListener('popstate', popState, true);
  return () => {
    active = false; pending = null;
    browser.removeEventListener('popstate', popState, true);
    if (history.pushState === pushState) history.pushState = originalPush;
    if (history.replaceState === replaceState) history.replaceState = originalReplace;
  };
}
