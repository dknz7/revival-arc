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

  // How Vivaldi's tab move (tabsPrivate.move) reads its target, found once with no side effects: an empty move with the
  // "target-is-tab" tweak, which Vivaldi 8.3 rejects in its argument check (there a number is always a tab id the tabs
  // land before, or "first" / "last") and 8.2 answers with "nothing to move" (a number is an index). True on 8.3.
  // Shared by tab folders (10-sidebar.js) and setSpace. Another error is thrown, and the question is asked again next time.
  let byTab = null;
  const movesByTab = async () => {
    if (byTab !== null) return byTab;
    try {
      await vivaldi.tabsPrivate.move({ tabIds: [], target: 0, tweaks: ["target-is-tab"], debug: "Vivarc.probe" });
      byTab = false;
    } catch (error) {
      if (!/Value must be one of/.test(String(error))) throw error;
      byTab = true;
    }
    return byTab;
  };

  // Puts tab `id` into space `spaceId` (0: the default space) in window `windowId` (default: its own), at `index` there
  // (default: where it is in its own window, the end of another). The one way Vivarc sets a tab's space, used only on a
  // deliberate move (spec Part 2: Vivarc does not stamp spaces). Measured in the sandbox (task 8t):
  // - Vivaldi 8.2 takes a space from a vivExtData write (chrome.tabs.update merges vivExtData; workspaceId 0 drops the
  //   key) and a window from chrome.tabs.move.
  // - Vivaldi 8.3 owns the key: a workspaceId written to vivExtData (update or create) is dropped while every other key
  //   still merges, and its own Move to Workspace and tab drop set a space with tabsPrivate.move({ workspaceId }). It
  //   keeps a space in one window: a move into a space with tabs in another window is refused ("ambiguous windowId")
  //   unless it takes the tab into that window, and chrome.tabs.move silently leaves a hidden space's tab where it is.
  //   Without a windowId its move also fails for a space with no tabs, or a tab its window does not show. So on 8.3 it is
  //   one move, always with the window: onto the tab itself (it stays where it is) or before the tab at `index` (or last).
  // Which Vivaldi this is comes from movesByTab; on 8.3 a move that does not take is followed by the 8.2 write, in case
  // a Vivaldi takes that again. The tab is read back after: this throws when it is not where it was asked to be.
  const setSpace = async (id, spaceId, { windowId, index } = {}) => {
    const space = spaceId || 0;
    const tab = await chrome.tabs.get(id);
    const win = windowId ?? tab.windowId;
    if (win === tab.windowId && index == null && spacesOf.of(tab) === space) return;
    const write = async () => {
      const now = await chrome.tabs.get(id);
      if (spacesOf.of(now) !== space) await chrome.tabs.update(id, { vivExtData: spacesOf.restamp(now, space) });
    };
    if (await movesByTab()) {
      let target = id;
      if (win !== tab.windowId || index != null) {
        const others = (await chrome.tabs.query({ windowId: win })).filter((t) => t.id !== id).sort((a, b) => a.index - b.index);
        target = index == null || index < 0 ? "last" : (others[index]?.id ?? "last");
      }
      const moved = await vivaldi.tabsPrivate.move({ tabIds: [id], target, windowId: win, tweaks: ["do-not-reparent"],
        workspaceId: space, debug: "Vivarc.setSpace" });
      if (!(await landed(id, space, win))) {
        if ((await chrome.tabs.get(id)).windowId === win) await write();
        if (!(await landed(id, space, win))) throw new Error(`Vivaldi did not put the tab in that space${moved?.message ? `: ${moved.message}` : ""}`);
      }
      return;
    }
    if (win !== tab.windowId || index != null) {
      await chrome.tabs.move(id, { windowId: win, index: index ?? -1 });
      let now = await chrome.tabs.get(id);
      for (let i = 0; i < 20 && now.windowId !== win; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        now = await chrome.tabs.get(id);
      }
      // Not there: no write, which would stamp the target window's space on a tab still in its old window.
      if (now.windowId !== win) throw new Error("the tab did not arrive in that window");
    }
    await write();
    if (!(await landed(id, space, win))) throw new Error("Vivaldi did not put the tab in that space");
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
  // On Vivaldi 8.3 the move is setSpace's instead (into the window found here): 8.3's own Move to Workspace moves with
  // no window and fails into a space with no tabs anywhere ("invalid workspaceId"), measured in task 8t.
  const moveToSpace = async (tabIds, spaceId) => {
    const vivaldiMove = (await movesByTab()) ? null : mover();
    const move = vivaldiMove ? (tab, windowId) => vivaldiMove({ id: tab.id, windowId }, spaceId)
      : byTab ? (tab, windowId) => setSpace(tab.id, spaceId, { windowId }) : null;
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
        await move(tab, target);
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
    setSpace,
    movesByTab,
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
