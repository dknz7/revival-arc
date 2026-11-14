// Repairs (spec Part 2, "Repairs"): Vivaldi can leave a window recorded on one space while it shows a tab of another,
// recorded on a deleted space or one it holds no tab of, or a space split across windows. After the events that can do
// that, once the browser settles, the leader window (workspaces.leaderOf) plans the fix on a fresh snapshot
// (workspaces.repairPlan) and carries it out, re-planning after each pass, at most 3 passes.
// Every window runs this; only the leader acts, decided again at each run, so a new leader takes over when the
// leader's window closes. Repairs never write a tab's space (a gather moves tabs, which keep their space, C1), with one
// exception: a tab whose space no longer exists moves to its window's default space (rule 0, the heal; Vivaldi 8.3
// restores a deleted space's closed tabs with the dead id, task 8y). The heal acts only on a workspace list it can trust
// (workspaces.healGate: two reads about 1 s apart, the pref and Vivaldi's store agreeing and non-empty), skips ids a
// "recently deleted spaces" store can still bring back, moves at most HEAL_MAX tabs a pass and logs each one.
// Without Vivaldi's record (or its switch) every rule would be guessing, so repairs then do nothing.
(() => {
  const SETTLE_MS = 400;
  const MAX_PASSES = 3;
  const BUSY_KEY = "__vivarcSpaceGesture";
  const BUSY_MAX_MS = 10000;
  const BUSY_CHECK_MS = 500;
  const COOL_MS = 10000;
  const HEAL_CONFIRM_MS = 1000;
  const DELETED_KEY = "deletedSpaces"; // undelete's store (08-space-edit.js, Task 9c): ids it can still revive are not healed
  const spacesOf = window.__vm.workspaces;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A tile gesture that moves a space (pull, move to a new window) runs in the window it was clicked in, which may not
  // be the leader, and passes through states a repair would act on (a new window recorded on the space before its tabs
  // arrive). It marks itself busy for at most 10 s, and repairs wait. The mark lives on Vivaldi's background page,
  // which every window shares (window.html has no localStorage: it is null there, measured); without it, on this window.
  const local = {};
  const shared = () => { try { return chrome.extension.getBackgroundPage?.() || local; } catch (_) { return local; } };
  const busyFor = () => {
    const left = (Number(shared()[BUSY_KEY]) || 0) - Date.now();
    return left > 0 && left <= BUSY_MAX_MS ? left : 0;
  };
  // Gestures can overlap (a drop into this window while another window's tear-off is still running): each holds its own
  // token on the shared page, the key stands at the latest of them, and ending one never lowers the guard of another
  // that is still running. A gesture that was never taken (or already ended) releases nothing.
  const MARKS_KEY = "__vivarcSpaceGestureMarks";
  const gesture = () => {
    const page = shared();
    const marks = page[MARKS_KEY] || (page[MARKS_KEY] = new Set());
    // a mark on the key that is no gesture's of ours (another script's) is kept: it stands again when ours ends
    const seen = Number(page[BUSY_KEY]) || 0;
    const token = { until: Date.now() + BUSY_MAX_MS, other: [...marks].some((m) => m.until === seen) ? 0 : seen };
    marks.add(token);
    page[BUSY_KEY] = Math.max(seen, token.until);
    return () => {
      const page = shared(), marks = page[MARKS_KEY];
      if (!marks || !marks.delete(token)) return; // not ours to release
      if (!marks.size) delete page[MARKS_KEY];
      const now = Date.now();
      const live = [token.other, ...[...marks].flatMap((m) => [m.until, m.other])].filter((u) => u > now);
      if (live.length) page[BUSY_KEY] = Math.max(...live);
      else if (!(Number(page[BUSY_KEY]) > token.until)) delete page[BUSY_KEY]; // a later mark set by other code stands
      schedule();
    };
  };
  // Is a gesture (any window's) in progress? A tear-off stands down while one is, e.g. another window's drop of this tab.
  const busy = () => busyFor() > 0;

  const warned = new Set();
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
  };

  const readSpaces = async () => {
    try {
      const list = (await vivaldi.prefs.get("vivaldi.workspaces.list"))?.value;
      return Array.isArray(list) ? list.map((w) => w.id) : null;
    } catch (_) { return null; }
  };

  // Vivaldi's record, or null when it can't be read: no store, or a store whose two answers disagree (all() falls back
  // to an empty map when it throws, which would read as every window on default).
  const readRecord = (windowIds) => {
    const record = window.__vm.native?.record() ?? null;
    if (!record) return null;
    const all = record.all();
    for (const w of windowIds) {
      const inWindow = [...all].find(([, x]) => x === w)?.[0] ?? 0;
      if (record.activeIn(w) !== inWindow) return null;
    }
    return all;
  };

  // The two lists the heal compares: the pref and Vivaldi's own store. spaceRepair.test.lists replaces this read (the
  // sandbox's guard case, R.heal-guard-unloaded).
  const readLists = async () => {
    const test = window.__vm.spaceRepair?.test;
    if (typeof test?.lists === "function") return test.lists();
    return { pref: await readSpaces(), store: window.__vm.native?.record()?.spaces?.() ?? null };
  };
  // The deleted spaces whose tabs may move this pass ([] when none, or when a guard says no). Asked only when a tab
  // carries an id the snapshot's list does not have, so a pass without such a tab waits for nothing.
  let lastWhy = null;
  const confirmHeal = async (snap) => {
    if (!spacesOf.strays(snap.tabs, snap.spaces)) return [];
    const first = await readLists();
    await sleep(HEAL_CONFIRM_MS);
    const second = await readLists();
    // Undelete's entries (08-space-edit.js), less the expired ones: an entry past its 30 days (or pushed out by the cap)
    // can no longer bring its tabs back, so they heal like any other (Task 9c). A store that cannot be read heals nothing
    // this pass: it might hold an entry.
    let skip = [];
    try {
      const store = window.__vm.store;
      skip = (await (store?.read ? store.read(DELETED_KEY) : store?.get(DELETED_KEY, []))) || [];
    } catch (_) { return []; }
    skip = Array.isArray(skip) ? skip : [];
    const edit = window.__vm.spaceEdit;
    if (edit?.held) skip = edit.held(skip, Date.now());
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const { ids, why } = spacesOf.healGate({ first, second, tabs, skip });
    if (why && why !== lastWhy) console.warn(`[vivarc] repair: tabs of a deleted space left as they are: ${why}`);
    lastWhy = why;
    return ids;
  };

  let ownWindow = null;
  const snapshot = async () => {
    const windows = await chrome.windows.getAll();
    if (ownWindow == null || spacesOf.leaderOf(windows) !== ownWindow) return null;
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const record = readRecord(windows.filter((w) => w.type === "normal").map((w) => w.id));
    return { windows, tabs, record, spaces: await readSpaces() };
  };

  const carryOut = async (step) => {
    let line;
    try {
      if (step.kind === "switch") {
        line = `window ${step.window} to ${step.space ? `space ${step.space}` : "its default space"}`;
        await window.__vm.native.switchTo(step.window, step.space);
      } else if (step.kind === "activate") {
        line = `activate tab ${step.tab}`;
        await chrome.tabs.update(step.tab, { active: true });
      } else if (step.kind === "rehome") {
        line = `tab ${step.tab} from deleted space ${step.from} to its window's default space`;
        await window.__vm.native.setSpace(step.tab, 0, { windowId: step.window });
      } else if (step.kind === "gather") {
        line = `gather space ${step.space} into window ${step.window} (tabs ${step.tabs.join(", ")})`;
        await chrome.tabs.move(step.tabs, { windowId: step.window, index: -1 });
      }
      console.log(`[vivarc] repair: ${line}`);
    } catch (error) {
      console.warn(`[vivarc] repair: ${line} failed:`, error);
    }
  };

  // One run: up to 3 passes, each planned on a fresh snapshot. -> "done" (nothing left to do, not the leader, or no
  // record), "wait" (a gesture's mark: try again later) or "stuck" (still drifting after 3 passes).
  const passes = async () => {
    for (let pass = 1; ; pass++) {
      if (busyFor()) return "wait";
      let snap = await snapshot();
      if (!snap) return "done";
      if (!snap.record || !window.__vm.native.hasSwitch()) {
        warnOnce("record", "[vivarc] repairs are off: Vivaldi's workspace record or switch could not be found");
        return "done";
      }
      const heal = await confirmHeal(snap);
      if (busyFor()) return "wait";
      // The heal waited about 1 s: the whole plan is made on a fresh snapshot (a record from before the wait, beside the
      // tabs after it, could snap back a switch made in between).
      if (heal.length) {
        snap = await snapshot();
        if (!snap?.record) return "done";
      }
      const plan = spacesOf.repairPlan(heal.length ? { ...snap, heal } : snap);
      if (!plan.length) return "done";
      if (pass > MAX_PASSES) return "stuck";
      for (const step of plan) await carryOut(step);
      await sleep(SETTLE_MS);
    }
  };

  // Events while a run is under way are mostly the run's own; it re-plans anyway. They earn one more run afterwards,
  // unless the run got stuck: then repairs rest for 10 s, so a fight with Vivaldi can't loop.
  let timer = 0, running = false, dirty = false, restUntil = 0;
  const schedule = (ms = SETTLE_MS) => {
    if (running) { dirty = true; return; }
    clearTimeout(timer);
    timer = setTimeout(run, Math.max(ms, restUntil - Date.now()));
  };
  const run = async () => {
    // a gesture's mark is cleared when it ends, in whichever window it ran: look again shortly
    if (busyFor()) { schedule(BUSY_CHECK_MS); return; }
    running = true;
    dirty = false;
    let result = "done";
    try { result = await passes(); } catch (_) {}
    running = false;
    if (result === "stuck") {
      warnOnce("stuck", `[vivarc] repair: still drifting after ${MAX_PASSES} passes; resting ${COOL_MS / 1000} s`);
      restUntil = Date.now() + COOL_MS;
    } else if (result === "wait") {
      // a busy mark is looked at again shortly
      schedule(BUSY_CHECK_MS);
    } else if (dirty) schedule();
  };

  window.__vm.spaceRepair = { schedule, gesture, busy };

  const start = async () => {
    if (!(await window.__vm.ready)) return;
    try { ownWindow = (await chrome.windows.getCurrent()).id; } catch (_) { return; }
    for (const ev of ["onActivated", "onAttached", "onDetached", "onRemoved"]) chrome.tabs[ev]?.addListener(() => schedule());
    // a deleted space's tab put back in the background (Vivaldi's own Reopen Closed Tab can) sets off nothing else
    let known = null;
    chrome.tabs.onCreated?.addListener((tab) => { if (spacesOf.deadSpace(tab, known)) schedule(); });
    chrome.windows.onRemoved?.addListener(() => schedule());
    // a space created or deleted: the same comparison as the sidebar's 3 s poll of the workspace list
    known = await readSpaces();
    let spaces = JSON.stringify(known);
    setInterval(async () => {
      known = await readSpaces();
      const now = JSON.stringify(known);
      if (now !== spaces) { spaces = now; schedule(); }
    }, 3000);
    schedule();
  };
  start();
})();
