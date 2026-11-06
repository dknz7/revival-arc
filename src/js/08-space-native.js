// Vivaldi's own workspace machinery, found in its webpack modules: the record of which space each window shows, and the
// switch. Vivaldi's record is the only truth for what a window shows; the active tab's space is a fallback for when the
// record cannot be found. Lookups are kept once they succeed and retried at most every 5 s while missing, so a Vivaldi
// that hides them costs one scan per 5 s and never an exception in the UI.
(() => {
  const RETRY_MS = 5000;
  const spacesOf = window.__vm.workspaces;

  const chunkLists = () => [window.webpackChunkgapp_browser_react, chrome.extension?.getBackgroundPage?.()?.webpackChunkgapp_browser_react];

  const lookup = (find) => {
    let found = null, lastTry = -Infinity;
    return () => {
      if (found) return found;
      const now = Date.now();
      if (now - lastTry < RETRY_MS) return null;
      lastTry = now;
      try {
        for (const chunks of chunkLists()) {
          found = (chunks && find(chunks)) || null;
          if (found) break;
        }
      } catch (_) { found = null; }
      return found;
    };
  };

  const record = lookup((chunks) => spacesOf.findRecord(chunks));
  const switcher = lookup((chunks) => spacesOf.findSwitcher(chunks));

  window.__vm.native = {
    record,
    // The space 0 (default) is passed to Vivaldi as undefined, which findSwitcher does.
    switchTo: async (windowId, spaceId) => {
      const activate = switcher();
      if (!activate) throw new Error("Native workspace switching is unavailable");
      return activate(windowId, spaceId);
    },
    focus: (windowId) => chrome.windows.update(windowId, { focused: true }).then(() => undefined),
  };
})();
