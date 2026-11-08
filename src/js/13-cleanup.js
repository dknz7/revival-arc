// Clean Up (Task 8n): tabs idle for a week are closed, remembered in Recently Cleaned for 30 days, and can be brought back.
// The pure parts (which tabs, what is kept, when it is due, where a tab returns) are in 07-workspaces.js; this is the
// part that talks to the browser, shared by the New Tab dropdown (10-sidebar.js: Clean Up Tabs, Recently Cleaned) and the
// daily runner below. It is a module of its own because both the menu and the runner need the same store, close and reopen
// code, and 10-sidebar.js is already the largest file.
//
// Daily: every window runs this file, only the leader window (workspaces.leaderOf, as repairs do) acts. It looks at
// start-up (after a pause, so a restored session has settled) and every 30 minutes, and cleans when the last run was a
// day ago or more. The run time is written BEFORE the cleaning, so a second start inside the day finds it recorded.
//
// Test hook, OFF by default: `window.__vm.cleanup.test` is null and nothing in Vivarc sets it. The sandbox sets it to
// { now: () => ms, idleMs: ms } to move the clock and the idle limit, because Vivaldi's lastAccessed cannot be backdated.
(() => {
  const spacesOf = window.__vm.workspaces;
  const { store } = window.__vm;
  if (!spacesOf || !store) return;
  const LIST = "cleaned";
  const LAST = "lastCleanup";
  const START_DELAY_MS = 15000;
  const CHECK_MS = 30 * 60 * 1000;
  const TOAST_MS = 8000;

  const api = { test: null };
  const now = () => { try { const t = api.test?.now?.(); if (Number.isFinite(t)) return t; } catch (_) {} return Date.now(); };
  const idleMs = () => { const t = api.test?.idleMs; return Number.isFinite(t) && t > 0 ? t : spacesOf.CLEAN_IDLE_MS; };
  const warn = (what, error) => console.warn(`[vivarc] cleanup: ${what}:`, error);
  const toast = (message, action = null, ms = undefined) => window.dispatchEvent(new CustomEvent("vm-toast", { detail: { message, action, ms } }));
  const plural = (n) => `${n} tab${n === 1 ? "" : "s"}`;

  // ---- the Recently Cleaned store (per profile) ----
  // Changes to it go one after another in this window, each from a fresh read.
  let queue = Promise.resolve();
  const load = async () => {
    const raw = await store.get(LIST, []);
    return spacesOf.keepCleaned(Array.isArray(raw) ? raw : [], [], now());
  };
  const list = () => load().catch((error) => { warn("read the list", error); return []; });
  const mutate = (change) => {
    const run = queue.then(async () => { const next = change(await load()); await store.set(LIST, next); return next; });
    queue = run.catch(() => {});
    return run;
  };
  const same = (a, b) => a.url === b.url && a.space === b.space && a.cleanedAt === b.cleanedAt && a.title === b.title;
  // `list` without one entry for each of `gone` (two identical entries lose two, not both of one)
  const without = (entries, gone) => {
    const left = [...gone];
    return entries.filter((e) => { const i = left.findIndex((g) => same(e, g)); if (i < 0) return true; left.splice(i, 1); return false; });
  };
  const forget = (gone) => mutate((entries) => without(entries, gone));
  const clearAll = () => mutate(() => []);

  // ---- cleaning ----
  // Closes the tabs cleanupSet picks (win / space: the scope, both left out for every space of every window), under the
  // repair busy mark. The entries are written BEFORE the tabs close, so a crash between the two loses nothing; if closing
  // fails, the entries of the tabs still open are taken back out. -> { count, entries } of what really closed.
  const run = async ({ win, space } = {}) => {
    const end = window.__vm.spaceRepair?.gesture() ?? null;
    try {
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      const at = now();
      // in window order, so the entries (and Undo) keep the order the tabs had
      const ids = spacesOf.cleanupSet({ tabs, now: at, space, window: win, idleMs: idleMs() });
      const order = new Map(tabs.map((t) => [t.id, [t.windowId, t.index]]));
      ids.sort((a, b) => order.get(a)[0] - order.get(b)[0] || order.get(a)[1] - order.get(b)[1]);
      if (!ids.length) return { count: 0, entries: [], tried: 0 };
      const byId = new Map(tabs.map((t) => [t.id, t]));
      const entries = ids.map((id) => spacesOf.cleanedEntry(byId.get(id), at));
      await mutate((kept) => spacesOf.keepCleaned(kept, entries, at));
      let closed = ids;
      try { await chrome.tabs.remove(ids); } catch (error) {
        warn("close", error);
        const open = new Set((await chrome.tabs.query({ windowType: "normal" })).map((t) => t.id));
        closed = ids.filter((id) => !open.has(id));
        const still = entries.filter((_, i) => open.has(ids[i]));
        if (still.length) await forget(still);
      }
      return { count: closed.length, entries: entries.filter((_, i) => closed.includes(ids[i])), tried: ids.length };
    } finally { end?.(); }
  };

  const readSpaces = async () => {
    try {
      const spaces = (await vivaldi.prefs.get("vivaldi.workspaces.list"))?.value;
      return Array.isArray(spaces) ? spaces.map((w) => w.id) : null;
    } catch (_) { return null; }
  };
  const hereId = async () => (await chrome.windows.getCurrent()).id;
  const shownIn = async (win) => window.__vm.native?.record()?.activeIn(win) ?? spacesOf.activeId(await chrome.tabs.query({ windowId: win }));

  // Opens the entries as new tabs, each in its space in the window that space lives in (the default space: this window;
  // a space that is gone: the space on screen here), under the repair busy mark. show: the last one made is then shown
  // the way a command-bar pick shows a tab (its space first, its window forward), so Vivaldi's record and the screen
  // agree. -> the entries that opened.
  const reopen = async (entries, { show = false } = {}) => {
    const end = window.__vm.spaceRepair?.gesture() ?? null;
    const opened = [];
    try {
      const here = await hereId();
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      const record = window.__vm.native?.record()?.all() ?? new Map();
      const spaces = await readSpaces();
      const shown = await shownIn(here);
      let last = null;
      for (const entry of entries) {
        try {
          const home = spacesOf.cleanedHome({ entry, here, shown, spaces, tabs, record });
          const made = await chrome.tabs.create({ windowId: home.window, url: entry.url, active: false, vivExtData: JSON.stringify({ workspaceId: home.space }) });
          // Vivaldi files a new tab in the space on screen unless told otherwise: read back, put right if it differs
          let fresh = made;
          try { fresh = await chrome.tabs.get(made.id); } catch (_) {}
          if (spacesOf.of(fresh) !== home.space) await chrome.tabs.update(made.id, { vivExtData: spacesOf.restamp(fresh, home.space) });
          opened.push(entry);
          last = made;
        } catch (error) { warn("reopen", error); }
      }
      if (show && last) {
        const tab = await chrome.tabs.get(last.id);
        if (window.__vm.pickTab) await window.__vm.pickTab(tab); else await chrome.tabs.update(tab.id, { active: true });
      }
    } catch (error) { warn("reopen", error); }
    finally { end?.(); }
    return opened;
  };

  // A row of Recently Cleaned: reopened in its space and shown, then taken off the list.
  const reopenOne = async (entry) => {
    const opened = await reopen([entry], { show: true });
    if (!opened.length) { toast("Could not reopen that"); return false; }
    await forget(opened).catch((error) => warn("update the list", error));
    return true;
  };
  // Undo for a run: those tabs again, in their spaces, off the list.
  const undo = async (entries) => {
    const opened = await reopen(entries);
    if (opened.length) await forget(opened).catch((error) => warn("update the list", error));
    if (opened.length < entries.length) toast(`Could not reopen ${plural(entries.length - opened.length)}; they are in Recently Cleaned`);
  };

  // Clean Up Tabs from the dropdown: this window's space on screen.
  const cleanUpNow = async () => {
    try {
      const win = await hereId();
      const done = await run({ win, space: await shownIn(win) });
      if (!done.count) { toast(done.tried ? "Could not clean up the tabs" : "Nothing to clean"); return done; }
      toast(`Cleaned ${plural(done.count)}`, { label: "Undo", run: () => undo(done.entries) }, TOAST_MS);
      return done;
    } catch (error) {
      warn("clean up", error);
      toast("Could not clean up the tabs");
      return { count: 0, entries: [] };
    }
  };

  // ---- the daily run ----
  let ownWindow = null;
  let looking = false;
  // One look: -> what it did ("off", "not leader", "busy", "not due", or the number of tabs cleaned). Two looks at once
  // (start-up and the timer landing together) would both find it due before either records it: the second stands down.
  const tick = async () => {
    if (looking) return "busy";
    looking = true;
    try {
      if (!window.__vm.settings?.get("cleanupDaily")) return "off";
      if (ownWindow == null) ownWindow = await hereId();
      if (spacesOf.leaderOf(await chrome.windows.getAll()) !== ownWindow) return "not leader";
      if (window.__vm.spaceRepair?.busy()) return "busy"; // a gesture is moving tabs: the next look will do
      const at = now();
      if (!spacesOf.cleanupDue(await store.get(LAST, 0), at)) return "not due";
      await store.set(LAST, at); // first: a second start inside the day finds it recorded
      const done = await run({});
      console.log(`[vivarc] cleanup: ${done.count} tabs`);
      return done.count;
    } catch (error) { warn("daily run", error); return "error"; }
    finally { looking = false; }
  };

  Object.assign(api, { now, idleMs, list, run, reopen, reopenOne, undo, forget, clearAll, cleanUpNow, tick, LAST });
  window.__vm.cleanup = api;

  const start = async () => {
    if (!(await window.__vm.ready)) return;
    await window.__vm.settings?.loaded;
    setTimeout(tick, START_DELAY_MS);
    setInterval(tick, CHECK_MS);
  };
  start().catch((error) => warn("start", error));
})();
