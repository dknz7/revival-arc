// Repairs (spec Part 2, "Repairs"): Vivaldi can leave a window recorded on one space while it shows a tab of another,
// recorded on a deleted space or one it holds no tab of, or a space split across windows. After the events that can do
// that, once the browser settles, the leader window (workspaces.leaderOf) plans the fix on a fresh snapshot
// (workspaces.repairPlan) and carries it out, re-planning after each pass, at most 3 passes.
// Every window runs this; only the leader acts, decided again at each run, so a new leader takes over when the
// leader's window closes. Repairs never write a tab's space (a gather moves tabs, which keep their space, C1), with one
// exception: a tab whose space no longer exists moves to its window's default space (rule 0, the heal; Vivaldi 8.3
// restores a deleted space's closed tabs with the dead id, task 8y). The heal acts only on a workspace list it can trust
// (workspaces.healGate: two reads about 1 s apart, the pref and Vivaldi's store agreeing and non-empty), moves at most
// HEAL_MAX tabs a pass, logs each one, and tags each healed tab healedFrom: <the deleted id> (heal policy B, Byron,
// 2026-11-15: a deleted space's tabs heal at once, and undelete takes the tagged ones back).
// Without Vivaldi's record (or its switch) every rule would be guessing, so repairs then do nothing.
(() => {
  const SETTLE_MS = 400;
  const MAX_PASSES = 3;
  const BUSY_KEY = "__vivarcSpaceGesture";
  const BUSY_MAX_MS = 10000;
  const BUSY_CHECK_MS = 500;
  const COOL_MS = 10000;
  const HEAL_CONFIRM_MS = 1000;
  const HEALED_FROM = "healedFrom"; // heal policy B: on a healed tab, the deleted space it came from (undelete reads it)
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
  // -> { waited, evidence }: evidence is the heal's go-ahead for this pass ({ ids, list }) or null (nothing may move);
  // waited says the check slept (the caller then takes a fresh snapshot). Asked only when a tab carries an id the snapshot's
  // list does not have, so a pass without such a tab waits for nothing. Never from a private window's copy of Vivarc: it
  // does not act on the profile's own windows (05-bootstrap.js).
  let lastWhy = null;
  const confirmHeal = async (snap) => {
    if (!spacesOf.strays(snap.tabs, snap.spaces)) return { waited: false, evidence: null, why: null };
    if (chrome.extension?.inIncognitoContext) return { waited: false, evidence: null, why: null };
    const first = await readLists();
    await sleep(HEAL_CONFIRM_MS);
    const second = await readLists();
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const { ids, list, why } = spacesOf.healGate({ first, second, tabs });
    if (why && why !== lastWhy) console.warn(`[vivarc] repair: tabs of a deleted space left as they are: ${why}`);
    lastWhy = why;
    return { waited: true, evidence: ids.length ? { ids, list } : null, why };
  };

  let ownWindow = null;
  const leading = async () => ownWindow != null && spacesOf.leaderOf(await chrome.windows.getAll()) === ownWindow;
  const snapshot = async () => {
    const windows = await chrome.windows.getAll();
    if (ownWindow == null || spacesOf.leaderOf(windows) !== ownWindow) return null;
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const record = readRecord(windows.filter((w) => w.type === "normal").map((w) => w.id));
    return { windows, tabs, record, spaces: await readSpaces() };
  };
  const landedAt = async (id, check) => {
    for (let look = 0; look < 8; look++) {
      if (look) await sleep(100);
      const tab = await chrome.tabs.get(id).catch(() => null);
      const verdict = check(tab);
      if (verdict !== "wait") return verdict;
    }
    return "it did not land";
  };

  // One heal step: the one place a repair sets a space (Task 9a fix round 2: "it heals the stranded tabs, and nothing
  // else ever moves"). Everything that has to wait is done first: the mover's version probe, the pref list, the sandbox's
  // hook. Then the leader's window list and the tab are read together, and from there to the single
  // move call nothing is awaited: the gesture mark, leadership, the tab (same window, still on the planned dead id) and
  // Vivaldi's own store list (read synchronously, still the approved list) are checked, and the move is made. No
  // fallback write: if the move does not land the batch stops and the tab stays as it is. After it, the tab must be in its
  // window's default space at its own place, and a gesture that started meanwhile also stops the batch.
  // -> null (moved) or why not.
  const rehome = async (step, evidence, nth) => {
    const native = window.__vm.native;
    const modern = await native.movesByTab(); // cached after its first answer
    const { pref, store: testStore } = await readLists();
    // spaceRepair.test.beforeStep(step, n): the sandbox's way to act while a step's reads are pending (R.heal-step-*)
    await Promise.resolve(window.__vm.spaceRepair?.test?.beforeStep?.(step, nth)).catch(() => {});
    const [windows, tab] = await Promise.all([chrome.windows.getAll(), chrome.tabs.get(step.tab).catch(() => null)]);
    // ---- no await from here to the move ----
    if (busyFor()) return "a gesture started";
    if (ownWindow == null || spacesOf.leaderOf(windows) !== ownWindow) return "this window no longer leads";
    const store = typeof window.__vm.spaceRepair?.test?.lists === "function" ? testStore : (native.record()?.spaces?.() ?? null);
    const why = spacesOf.healStepOk({ step, tab, pref, store, list: evidence.list });
    if (why) return why;
    const index = tab.index;
    let moving;
    try {
      moving = modern
        ? vivaldi.tabsPrivate.move({ tabIds: [step.tab], target: step.tab, windowId: step.window, tweaks: ["do-not-reparent"], workspaceId: 0, debug: "Vivarc.heal" })
        : chrome.tabs.update(step.tab, { vivExtData: spacesOf.restamp(tab, 0) }); // 8.2 takes a space from this write
    } catch (error) { return `the move was refused (${error?.message ?? error})`; }
    // ---- the move is under way ----
    try { await moving; } catch (error) { return `the move failed (${error?.message ?? error})`; }
    const verdict = await landedAt(step.tab, (now) => {
      if (!now) return "the tab is gone";
      if (now.windowId !== step.window) return "the tab left its window";
      if (spacesOf.of(now) !== 0) return spacesOf.of(now) === step.from ? "wait" : "the tab went into another space";
      return now.index === index ? null : "the tab changed place";
    });
    if (verdict) return verdict;
    // Heal policy B: the healed tab is tagged with the space it came from (a merge write: on 8.3 every vivExtData key but
    // workspaceId is kept), so undelete can take it back (08-space-edit.js). Only after the verified move, never in its
    // place; a tag that does not take is warned and the move stands.
    try { await chrome.tabs.update(step.tab, { vivExtData: JSON.stringify({ [HEALED_FROM]: step.from }) }); }
    catch (error) { console.warn(`[vivarc] repair: tab ${step.tab} healed, but its healedFrom tag was not written:`, error); }
    if (busyFor()) return "a gesture started during the move (moved; the rest is planned again)";
    return null;
  };

  // A gather, checked like a heal step (fix round 3): the list is read first; then the window list, every tab and the
  // gathered tabs are read together, and with no further await: the gesture mark, leadership, the list holding the space,
  // each gathered tab still in that space AND still in the window it was planned from (sources: tab id -> window, from
  // the snapshot the plan was made on), the target window still open, and the space still living there now (Vivaldi's
  // record read at that moment, else most of its tabs: a space the user pulled elsewhere meanwhile is not dragged back).
  // Then one chrome.tabs.move. -> null (moved) or why not.
  const gather = async (step, sources) => {
    const list = spacesOf.spaceList(await readSpaces());
    const [windows, all, now] = await Promise.all([chrome.windows.getAll(), chrome.tabs.query({ windowType: "normal" }),
      Promise.all(step.tabs.map((id) => chrome.tabs.get(id).catch(() => null)))]);
    // ---- no await from here to the move ----
    if (busyFor()) return "a gesture started";
    if (ownWindow == null || spacesOf.leaderOf(windows) !== ownWindow) return "this window no longer leads";
    if (!list?.includes(step.space)) return "the space is not in a valid list";
    if (!windows.some((w) => w.id === step.window && w.type === "normal")) return "the target window is gone";
    if (!now.every((t) => t && spacesOf.of(t) === step.space && t.windowId !== step.window && sources?.get(t.id) === t.windowId)) return "its tabs changed";
    const record = window.__vm.native?.record()?.all() ?? null;
    if (!record || spacesOf.livesIn(all, record, step.space) !== step.window) return "the space lives somewhere else now";
    return chrome.tabs.move(step.tabs, { windowId: step.window, index: -1 }).then(() => null);
  };

  // The other steps, each re-checked as it runs: leadership; a switch into a named space only while a valid list holds
  // it; an activation only of a tab still there; a gather as above. -> false: the plan stops here (a step that did not go
  // ahead or failed), and the next pass plans again on what is there then. snap: the snapshot the plan was made on.
  const carryOut = async (step, evidence, nth, snap) => {
    let line;
    const stop = (why) => { console.warn(`[vivarc] repair: ${line} not done (${why}); planning again`); return false; };
    try {
      if (step.kind === "rehome") {
        line = `tab ${step.tab} from deleted space ${step.from} to its window's default space`;
        const why = evidence ? await rehome(step, evidence, nth) : "no evidence";
        if (why) return stop(why);
      } else {
        if (!(await leading())) return stop("this window no longer leads");
        if (step.kind === "switch") {
          line = `window ${step.window} to ${step.space ? `space ${step.space}` : "its default space"}`;
          if (step.space && !spacesOf.spaceList(await readSpaces())?.includes(step.space)) return stop("the space is not listed");
          await window.__vm.native.switchTo(step.window, step.space);
        } else if (step.kind === "activate") {
          line = `activate tab ${step.tab}`;
          if (!(await chrome.tabs.get(step.tab).catch(() => null))) return stop("the tab is gone");
          await chrome.tabs.update(step.tab, { active: true });
        } else if (step.kind === "gather") {
          line = `gather space ${step.space} into window ${step.window} (tabs ${step.tabs.join(", ")})`;
          const why = await gather(step, new Map((snap?.tabs || []).map((t) => [t.id, t.windowId])));
          if (why) return stop(why);
        }
      }
      console.log(`[vivarc] repair: ${line}`);
      return true;
    } catch (error) {
      console.warn(`[vivarc] repair: ${line} failed:`, error);
      return false;
    }
  };

  // One run: up to 3 passes, each planned on a fresh snapshot. -> "done" (nothing left to do, or not the leader), "wait"
  // (a gesture's mark: try again shortly), "stuck" (still drifting after 3 passes), or "unavailable" (Vivaldi's record or
  // switch is not there yet, or the heal was refused for a reason that can pass: a list not loaded, unreadable, empty or
  // changing), which brings the run back with a growing delay. healLeft: the last plan
  // still held a heal step, so a stuck run comes back after its rest.
  let healLeft = false;
  const TEMPORARY = new Set(["a workspace list could not be read", "a workspace list is empty", "the workspace lists disagree or changed"]);
  const passes = async () => {
    for (let pass = 1; ; pass++) {
      if (busyFor()) return "wait";
      let snap = await snapshot();
      if (!snap) return "done";
      if (!snap.record || !window.__vm.native.hasSwitch()) {
        warnOnce("record", "[vivarc] repairs are waiting: Vivaldi's workspace record or switch could not be found yet");
        return "unavailable";
      }
      const { waited, evidence, why } = await confirmHeal(snap);
      if (waited) {
        // The heal's check waited about 1 s (approved or refused): the whole plan is made on a fresh snapshot, with
        // leadership and the gesture mark looked at again (a record from before the wait could snap back a switch made
        // in between). The fresh list must still be the approved one, or nothing is healed.
        if (busyFor()) return "wait";
        snap = await snapshot();
        if (!snap) return "done"; // no longer the leader
        if (!snap.record) return "unavailable"; // the leader's record went missing: try again, do not drop the work
      }
      const fresh = spacesOf.spaceList(snap.spaces);
      const heal = evidence && fresh && JSON.stringify(fresh) === JSON.stringify(evidence.list) ? evidence.ids : [];
      const plan = spacesOf.repairPlan({ ...snap, heal });
      healLeft = plan.some((p) => p.kind === "rehome");
      const pending = !!why && TEMPORARY.has(why) && spacesOf.strays(snap.tabs, snap.spaces);
      if (!plan.length) return pending ? "unavailable" : "done";
      if (pass > MAX_PASSES) return "stuck";
      let nth = 0;
      for (const step of plan) {
        if (busyFor()) return "wait";
        if (!(await carryOut(step, heal.length ? evidence : null, step.kind === "rehome" ? nth++ : null, snap))) break;
      }
      await sleep(SETTLE_MS);
    }
  };

  // Events while a run is under way are mostly the run's own; it re-plans anyway. They earn one more run afterwards,
  // unless the run got stuck: then repairs rest for 10 s, so a fight with Vivaldi can't loop. A run that found the heal
  // (or Vivaldi's record) not ready comes back by itself: 5 s, then 10, 20, 40, 60 s, ... for at most 10 minutes, then
  // it logs and waits for the next event or list change (the 3 s poll watches Vivaldi's store as well as the pref).
  const RETRY_FIRST_MS = 5000, RETRY_MAX_MS = 60000, RETRY_FOR_MS = 10 * 60 * 1000;
  let timer = 0, running = false, dirty = false, restUntil = 0, retryMs = 0, retrySince = 0;
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
    if (result !== "unavailable") { retryMs = 0; retrySince = 0; }
    if (result === "stuck") {
      warnOnce("stuck", `[vivarc] repair: still drifting after ${MAX_PASSES} passes; resting ${COOL_MS / 1000} s`);
      restUntil = Date.now() + COOL_MS;
      if (healLeft) schedule(); // heal work left: carry on after the rest (schedule waits for restUntil)
    } else if (result === "wait") {
      // a busy mark is looked at again shortly
      schedule(BUSY_CHECK_MS);
    } else if (result === "unavailable") {
      const now = Date.now();
      if (!retrySince) retrySince = now;
      if (now - retrySince > RETRY_FOR_MS) {
        warnOnce("gave-up", "[vivarc] repair: tabs of a deleted space are still waiting for a workspace list it can trust; trying again on the next change");
        retryMs = 0; retrySince = 0;
        if (dirty) schedule();
      } else {
        retryMs = retryMs ? Math.min(retryMs * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
        schedule(retryMs);
      }
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
    // ... and Vivaldi's own store, which fills at start-up after the pref is already readable: the heal waits for it
    const storeIds = () => { try { return JSON.stringify(window.__vm.native?.record()?.spaces?.() ?? null); } catch (_) { return "null"; } };
    known = await readSpaces();
    let spaces = JSON.stringify(known), stored = storeIds();
    setInterval(async () => {
      known = await readSpaces();
      const now = JSON.stringify(known), inStore = storeIds();
      if (now !== spaces || inStore !== stored) { spaces = now; stored = inStore; schedule(); }
    }, 3000);
    schedule();
  };
  start();
})();
