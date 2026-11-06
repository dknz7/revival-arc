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

  // Whether a tab is where a move should have put it, looked at 8 times over about 700 ms (Vivaldi's move can finish
  // just after it resolves).
  const landed = async (id, spaceId, windowId) => {
    for (let look = 0; look < 8; look++) {
      if (look) await new Promise((resolve) => setTimeout(resolve, 100));
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab && spacesOf.of(tab) === (spaceId || 0) && tab.windowId === windowId) return true;
    }
    return false;
  };

  // Moves tabs into a space with Vivaldi's own move, which keeps the window on the space it shows. Measured on 8.2:
  // - A tab that is on screen cannot leave its space without a switch of the record (G4; and a lone tab leaves a start
  //   page in the target space), so first the space's most recently used other tab takes the screen, or a blank tab when
  //   there is none.
  // - A space shown in another window is moved into that window: asked from the tab's own window, Vivaldi's move
  //   reports success and changes nothing ("ambiguous windowId").
  // - A space parked in another window cannot be reached: from the tab's window the move fails the same way, and asked
  //   with the holding window the tab lands in that window's SHOWN space. Refused before anything is touched.
  // - A space with no tabs anywhere is moved within the tab's own window.
  // Vivaldi's move does not throw when it fails, so the tab is read again: if it is not where it should be, what was
  // done first is undone (the original tab active again, a blank tab closed) and this throws.
  // Rejects, before touching anything, when Vivaldi's move is not found.
  const moveToSpace = async (tabIds, spaceId) => {
    const move = mover();
    if (!move) throw new Error("Moving tabs to a space is unavailable");
    const ids = [...tabIds];
    for (const id of ids) {
      const tab = await chrome.tabs.get(id);
      if (!tab || spacesOf.of(tab) === (spaceId || 0)) continue;
      const here = await chrome.tabs.query({ windowId: tab.windowId });
      const shown = record()?.activeIn(tab.windowId) ?? spacesOf.activeId(here);
      let target = tab.windowId;
      if (spaceId) {
        const shownIn = record()?.all().get(spaceId);
        const lives = spacesOf.livesIn(await chrome.tabs.query({ windowType: "normal" }), record()?.all() ?? new Map(), spaceId);
        if (shownIn == null && lives != null && lives !== tab.windowId) {
          const error = new Error("That space is parked in another window: show it there first");
          error.code = "parked-elsewhere";
          throw error;
        }
        target = lives ?? tab.windowId;
      }
      let keeper = null, blank = null;
      if (tab.active) {
        keeper = here.filter((t) => !ids.includes(t.id) && spacesOf.of(t) === shown)
          .reduce((best, t) => (!best || (t.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? t : best), null);
        if (keeper) await chrome.tabs.update(keeper.id, { active: true });
        else blank = await chrome.tabs.create({ windowId: tab.windowId, active: true });
      }
      let failure = null;
      try {
        await move({ id: tab.id, windowId: target }, spaceId);
        if (!(await landed(tab.id, spaceId, target))) failure = new Error("Vivaldi did not move the tab to that space");
      } catch (error) { failure = error; }
      if (failure) {
        if (keeper || blank) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        if (blank) await chrome.tabs.remove(blank.id).catch(() => {});
        throw failure;
      }
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
