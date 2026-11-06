// Repairs (spec Part 2, "Repairs"): Vivaldi can leave a window recorded on one space while it shows a tab of another,
// recorded on a deleted space or one it holds no tab of, or a space split across windows. After the events that can do
// that, once the browser settles, the leader window (workspaces.leaderOf) plans the fix on a fresh snapshot
// (workspaces.repairPlan) and carries it out, re-planning after each pass, at most 3 passes.
// Every window runs this; only the leader acts, decided again at each run, so a new leader takes over when the
// leader's window closes. Repairs never write a tab's space: a gather moves tabs, which keep their space (C1).
// Without Vivaldi's record (or its switch) every rule would be guessing, so repairs then do nothing.
(() => {
  const SETTLE_MS = 400;
  const MAX_PASSES = 3;
  const MOVED_MS = 5000;
  const BUSY_KEY = "__vivarcSpaceGesture";
  const BUSY_MAX_MS = 10000;
  const BUSY_CHECK_MS = 500;
  const COOL_MS = 10000;
  const spacesOf = window.__vm.workspaces;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Tabs Vivarc itself moved between windows, kept 5 s: the attach a gather causes is not a user's drag.
  window.__vm.movedByVivarc ??= new Set();
  const movedTimers = new Map();
  const markMoved = (ids) => {
    const moved = window.__vm.movedByVivarc;
    for (const id of ids) {
      moved.add(id);
      clearTimeout(movedTimers.get(id));
      movedTimers.set(id, setTimeout(() => { moved.delete(id); movedTimers.delete(id); }, MOVED_MS));
    }
  };

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
  const gesture = () => {
    const until = Date.now() + BUSY_MAX_MS;
    shared()[BUSY_KEY] = until;
    return () => {
      // only clear our own mark: a later gesture's must stand
      const page = shared();
      if (page[BUSY_KEY] === until) delete page[BUSY_KEY];
      schedule();
    };
  };

  // Work that must land before repairs plan (a restamp waiting on an attach): the next run waits until it settles.
  const holds = new Set();
  const hold = (promise) => {
    const settled = Promise.race([Promise.resolve(promise), sleep(BUSY_MAX_MS)]).catch(() => {})
      .finally(() => { holds.delete(settled); schedule(); });
    holds.add(settled);
    return settled;
  };

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
      } else if (step.kind === "gather") {
        line = `gather space ${step.space} into window ${step.window} (tabs ${step.tabs.join(", ")})`;
        markMoved(step.tabs);
        await chrome.tabs.move(step.tabs, { windowId: step.window, index: -1 });
      }
      console.log(`[vivarc] repair: ${line}`);
    } catch (error) {
      console.warn(`[vivarc] repair: ${line} failed:`, error);
    }
  };

  // One run: up to 3 passes, each planned on a fresh snapshot. -> "done" (nothing left to do, not the leader, or no
  // record), "wait" (a gesture's mark or a hold: try again later) or "stuck" (still drifting after 3 passes).
  const passes = async () => {
    for (let pass = 1; ; pass++) {
      if (busyFor() || holds.size) return "wait";
      const snap = await snapshot();
      if (!snap) return "done";
      if (!snap.record || !window.__vm.native.hasSwitch()) {
        warnOnce("record", "[vivarc] repairs are off: Vivaldi's workspace record or switch could not be found");
        return "done";
      }
      const plan = spacesOf.repairPlan(snap);
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
      // a hold schedules when it settles; a busy mark is looked at again shortly
      if (!holds.size) schedule(BUSY_CHECK_MS);
    } else if (dirty) schedule();
  };

  // A dragged tab joins the space of the window it lands in (spec Part 2, "Tabs" -> dragging; Vivaldi's own drop already
  // does this, so this is the safety net for moves done another way, which park the tab, C1). The leader handles it.
  // Vivaldi rehomes a closing window's tabs BEFORE the window goes (D2), and that must not read as a drag. So the source
  // window is watched for 1.5 s after the attach: any windows.onRemoved for it in that time, or its absence from
  // windows.getAll() at 500 ms or at 1.5 s, means it was closing and the tab keeps its space. Measured (8.2, sandbox):
  // first rehomed tab to removal ~0.3 s for 26 tabs, ~1.1 s for 60, ~2.5-2.9 s for 100 via Vivaldi's own close; in the
  // heavy closes this window's timers and getAll ran late, so the checks still landed after the removal. The wait is
  // held against repairs, so they never act on the tab before it joins its new space.
  const ATTACH_MS = 500;
  const CLOSING_MS = 1500;
  const sources = new Map(); // tab id -> the window it was last detached from
  const onDetached = (tabId, info) => {
    sources.set(tabId, info?.oldWindowId);
    setTimeout(() => sources.delete(tabId), 10000);
  };
  const closedWindows = new Set(); // windows removed in the last 10 s
  const onWindowRemoved = (windowId) => {
    closedWindows.add(windowId);
    setTimeout(() => closedWindows.delete(windowId), 10000);
  };
  // The removal set is read again after the look: while Vivaldi closes a heavy window, getAll took ~2 s and still listed
  // the window, and the removal arrived in the meantime (measured, 100 tabs).
  const sourceGone = async (windowId) => {
    if (windowId == null || closedWindows.has(windowId)) return true;
    const listed = (await chrome.windows.getAll()).some((w) => w.id === windowId);
    return !listed || closedWindows.has(windowId);
  };
  // A tile gesture (pull, move to a new window) moves a space's tabs with Vivaldi's own switch, which keeps their space,
  // into a window whose record may not be updated yet: never restamp during one. Checked at the attach and after the wait
  // (the gesture may have ended in between), in whichever window the gesture ran (its mark is on the shared page).
  const restampLater = async (tabId, newWindowId, oldWindowId, busyAtAttach) => {
    try {
      await sleep(ATTACH_MS);
      if (await sourceGone(oldWindowId)) return; // a closing window's rehoming (D2): the tab keeps its space
      await sleep(CLOSING_MS - ATTACH_MS);
      const windows = await chrome.windows.getAll();
      if (ownWindow == null || spacesOf.leaderOf(windows) !== ownWindow) return;
      const sourceWindowOpen = !(await sourceGone(oldWindowId));
      const shownSpace = window.__vm.native?.record()?.activeIn(newWindowId);
      if (shownSpace == null) { warnOnce("drag-record", "[vivarc] drag: Vivaldi's workspace record could not be read, so dragged tabs keep their space"); return; }
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== newWindowId) return; // it moved on again
      const data = spacesOf.restampOnAttach({ tab, shownSpace, sourceWindowOpen, movedByVivarc: window.__vm.movedByVivarc.has(tabId), gestureBusy: busyAtAttach || busyFor() > 0 });
      if (data == null || closedWindows.has(oldWindowId)) return; // the source may have gone during the awaits above
      await chrome.tabs.update(tabId, { vivExtData: data });
      console.log(`[vivarc] drag: tab ${tabId} joined ${shownSpace ? `space ${shownSpace}` : "the default space"} in window ${newWindowId}`);
    } catch (error) { warnOnce("drag-failed", `[vivarc] drag: a dragged tab could not join its window's space: ${error}`); }
  };
  const onAttached = (tabId, info) => {
    const from = sources.get(tabId);
    sources.delete(tabId);
    hold(restampLater(tabId, info?.newWindowId, from, busyFor() > 0));
  };

  window.__vm.spaceRepair = { schedule, hold, gesture, markMoved };

  const start = async () => {
    if (!(await window.__vm.ready)) return;
    try { ownWindow = (await chrome.windows.getCurrent()).id; } catch (_) { return; }
    for (const ev of ["onActivated", "onAttached", "onDetached", "onRemoved"]) chrome.tabs[ev]?.addListener(() => schedule());
    chrome.tabs.onDetached?.addListener(onDetached);
    chrome.tabs.onAttached?.addListener(onAttached);
    chrome.windows.onRemoved?.addListener((windowId) => { onWindowRemoved(windowId); schedule(); });
    // a space created or deleted: the same comparison as the sidebar's 3 s poll of the workspace list
    let spaces = JSON.stringify(await readSpaces());
    setInterval(async () => {
      const now = JSON.stringify(await readSpaces());
      if (now !== spaces) { spaces = now; schedule(); }
    }, 3000);
    schedule();
  };
  start();
})();
