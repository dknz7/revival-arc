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

  const mover = lookup((chunks) => spacesOf.findMover(chunks));

  // Moves tabs into a space with Vivaldi's own move, which keeps the window on the space it shows. A tab that is on
  // screen cannot leave its space without a switch of the record (G4, measured: the record follows, and a lone tab gets
  // a start page in the target space), so first the space's most recently used other tab takes the screen, or a blank
  // tab when there is none. Rejects, before touching anything, when Vivaldi's move is not found.
  const moveToSpace = async (tabIds, spaceId) => {
    const move = mover();
    if (!move) throw new Error("Moving tabs to a space is unavailable");
    const ids = [...tabIds];
    for (const id of ids) {
      const tab = await chrome.tabs.get(id);
      if (!tab || spacesOf.of(tab) === (spaceId || 0)) continue;
      const here = await chrome.tabs.query({ windowId: tab.windowId });
      const shown = record()?.activeIn(tab.windowId) ?? spacesOf.activeId(here);
      if (tab.active) {
        const keeper = here.filter((t) => !ids.includes(t.id) && spacesOf.of(t) === shown)
          .reduce((best, t) => (!best || (t.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? t : best), null);
        if (keeper) await chrome.tabs.update(keeper.id, { active: true });
        else await chrome.tabs.create({ windowId: tab.windowId, active: true });
      }
      // A space shown in another window is moved into that window; any other space is moved within the tab's own.
      const target = spaceId ? record()?.all().get(spaceId) ?? tab.windowId : tab.windowId;
      await move({ id: tab.id, windowId: target }, spaceId);
    }
  };

  window.__vm.native = {
    record,
    moveToSpace,
    // True when Vivaldi's switch is found; callers check before any side effect.
    hasSwitch: () => switcher() !== null,
    // The space 0 (default) is passed to Vivaldi as undefined, which findSwitcher does.
    switchTo: async (windowId, spaceId) => {
      const activate = switcher();
      if (!activate) throw new Error("Native workspace switching is unavailable");
      return activate(windowId, spaceId);
    },
    focus: (windowId) => chrome.windows.update(windowId, { focused: true }).then(() => undefined),
  };
})();
