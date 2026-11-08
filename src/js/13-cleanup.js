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
  // store.set (00-core.js) resolves even when the write fails and has no timeout, so nothing here trusts it: a write is
  // raced against a timeout, and a run reads the list back before it closes anything. Changes to the list run one after
  // another across ALL windows of the profile: a promise chain on the background page (which every window shares, like
  // the repair busy mark), each link waiting at most LOCK_MS for the one before, so a window that closed mid-change
  // cannot jam the rest. Without the background page the chain is this window's own.
  const STORE_MS = 12000; // a window rendering hundreds of tabs answers slowly: a read or write is given this long
  const LOCK_MS = 30000;
  const QUEUE = "__vivarcCleanupQueue";
  const local = {};
  const page = () => { try { return chrome.extension.getBackgroundPage?.() || local; } catch (_) { return local; } };
  const within = (promise, ms, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  const locked = (fn) => {
    const shared = page();
    const wait = Promise.race([shared[QUEUE] || Promise.resolve(), new Promise((resolve) => setTimeout(resolve, LOCK_MS))]);
    const mine = wait.then(fn);
    shared[QUEUE] = mine.catch(() => {});
    return mine;
  };
  const load = async () => {
    // store.read, not get: get resolves its fallback when the read FAILS, which would read as an empty list and the next
    // write would replace the real one. A failed read rejects here, so nothing is written over it. Absent is empty;
    // anything that is not a list throws.
    const raw = await within(store.read(LIST), STORE_MS, "reading the list");
    if (raw !== undefined && !Array.isArray(raw)) throw new Error("the stored list is not a list");
    return spacesOf.keepCleaned(raw ?? [], [], now());
  };
  const list = () => load().catch((error) => { warn("read the list", error); return []; });
  const mutate = (change) => locked(async () => {
    const next = change(await load());
    await within(store.set(LIST, next), STORE_MS, "writing the list");
    return next;
  });
  // `list` without one entry for each of `gone` (two identical entries lose two, not both of one)
  const without = (entries, gone) => {
    const left = [...gone];
    return entries.filter((e) => { const i = left.findIndex((g) => spacesOf.sameEntry(e, g)); if (i < 0) return true; left.splice(i, 1); return false; });
  };
  const forget = (gone) => mutate((entries) => without(entries, gone));
  const clearAll = () => mutate(() => []);

  // ---- cleaning ----
  // Closes the tabs cleanupSet picks (win / space: the scope, both left out for every space of every window), under the
  // repair busy mark. A tab closes only when it is certain to be recoverable:
  //  1. the entries are written BEFORE any tab closes (a failed or timed-out write closes nothing);
  //  2. the list is READ BACK, and only tabs whose entry is really in it close (the list holds 200: a bigger run closes
  //     only as many as fit, the rest stay open);
  //  3. just before closing, the tabs are looked at again and cleanupSet re-run on them, so a tab that became active,
  //     audible or private in the gap stays, and its entry is taken back out;
  //  4. if closing fails, the entries of the tabs still open are taken back out.
  // -> { count, entries (of what closed), tried, capped (stayed because the list was full), failed }
  const run = async ({ win, space } = {}) => {
    const end = window.__vm.spaceRepair?.gesture() ?? null;
    try {
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      const at = now();
      const pick = (all) => spacesOf.cleanupSet({ tabs: all, now: at, space, window: win, idleMs: idleMs() });
      // in window order, so the entries (and Undo) keep the order the tabs had
      const order = new Map(tabs.map((t) => [t.id, [t.windowId, t.index]]));
      const ids = pick(tabs).sort((a, b) => order.get(a)[0] - order.get(b)[0] || order.get(a)[1] - order.get(b)[1]);
      if (!ids.length) return { count: 0, entries: [], tried: 0, capped: 0, failed: false };
      const byId = new Map(tabs.map((t) => [t.id, t]));
      const entries = ids.map((id) => spacesOf.cleanedEntry(byId.get(id), at));
      const none = { count: 0, entries: [], tried: ids.length, capped: 0, failed: true };
      try { await mutate((kept) => spacesOf.keepCleaned(kept, entries, at)); } catch (error) { warn("store the list; nothing was closed", error); return none; }
      let ok;
      try { ok = spacesOf.confirmedEntries(await load(), entries); } catch (error) { warn("read the list back; nothing was closed", error); return none; }
      const capped = ok.filter((x) => !x).length;
      // nothing of it in the list: the write did not take (store.set resolves even when it fails)
      if (!ok.some(Boolean)) { warn("the list did not take the entries; nothing was closed", ""); return none; }
      if (capped) console.warn(`[vivarc] cleanup: ${capped} tabs stayed open: the Recently Cleaned list holds ${spacesOf.CLEAN_KEEP_MAX}`);
      const eligible = new Set(pick(await chrome.tabs.query({ windowType: "normal" })));
      const closing = ids.filter((id, i) => ok[i] && eligible.has(id));
      const spared = entries.filter((_, i) => ok[i] && !eligible.has(ids[i]));
      let failed = false;
      let closed = closing;
      if (closing.length) {
        try { await chrome.tabs.remove(closing); } catch (error) {
          warn("close", error);
          failed = true;
          const open = new Set((await chrome.tabs.query({ windowType: "normal" })).map((t) => t.id));
          closed = closing.filter((id) => !open.has(id));
          const still = entries.filter((_, i) => closing.includes(ids[i]) && open.has(ids[i]));
          if (still.length) await forget(still).catch((e) => warn("update the list", e));
        }
      }
      // after the close, not before: waiting for the list lock between the re-check and the close would make the re-check stale
      if (spared.length) await forget(spared).catch((error) => warn("update the list", error));
      return { count: closed.length, entries: entries.filter((_, i) => closed.includes(ids[i])), tried: ids.length, capped, failed };
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
      if (!done.count) { toast(done.failed ? "Could not clean up the tabs" : "Nothing to clean"); return done; }
      toast(`Cleaned ${plural(done.count)}${done.capped ? `; ${plural(done.capped)} stayed (the list is full)` : ""}`, { label: "Undo", run: () => undo(done.entries) }, TOAST_MS);
      return done;
    } catch (error) {
      warn("clean up", error);
      toast("Could not clean up the tabs");
      return { count: 0, entries: [] };
    }
  };

  // ---- the daily run ----
  let ownWindow = null;
  let ownPrivate = false;
  let looking = false;
  // One look: -> what it did ("off", "not leader", "busy", "not due", or the number of tabs cleaned). Two looks at once
  // (start-up and the timer landing together) would both find it due before either records it: the second stands down.
  const tick = async () => {
    if (looking) return "busy";
    looking = true;
    try {
      if (!window.__vm.settings?.get("cleanupDaily")) return "off";
      if (ownWindow == null) { const here = await chrome.windows.getCurrent(); ownWindow = here.id; ownPrivate = !!here.incognito; }
      if (ownPrivate) return "private"; // a private window never runs it
      if (spacesOf.cleanupLeader(await chrome.windows.getAll()) !== ownWindow) return "not leader";
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
