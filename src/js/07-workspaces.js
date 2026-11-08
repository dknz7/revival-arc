// Arc's Spaces on top of Vivaldi Workspaces: which workspace a tab is in, the list of spaces for the space bar,
// where switching to a space goes, and which pinned-links folder belongs to which space.
// A workspace is not a login: all of them share the profile's cookies (profiles are the isolation boundary).
(() => {
  const ARC_PREFIX = "Arc - ";

  // Vivaldi keeps the workspace id in the tab's vivExtData JSON; no key means the default space (id 0).
  const of = (tab) => {
    try { return Number(JSON.parse(tab?.vivExtData || "{}").workspaceId) || 0; } catch (_) { return 0; }
  };
  const tabsIn = (tabs, id) => tabs.filter((t) => of(t) === id);
  const activeId = (tabs) => {
    const active = tabs.find((t) => t.active);
    return active ? of(active) : 0;
  };

  // What the sidebar lists: the active space's tabs. With no known workspace everything is one space, so a failed
  // read of the list never hides tabs.
  const scope = (tabs, list) => {
    if (!list?.length) return { active: 0, tabs };
    const active = activeId(tabs);
    return { active, tabs: tabsIn(tabs, active) };
  };

  // Always include Home so the sidebar offers space switching and creation on a fresh profile.
  const items = (list, defaultName) => {
    return [{ id: 0, name: defaultName, emoji: "" }, ...(list || []).map((w) => ({ id: w.id, name: w.name, emoji: w.emoji || "", icon: w.icon || "" }))];
  };

  // Where switching to a space lands: its most recently used tab (Vivaldi then switches the workspace by itself).
  const recentTab = (tabs, id) => {
    const own = tabsIn(tabs, id);
    if (!own.length) return null;
    return own.reduce((best, t) => ((t.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ||
      ((t.lastAccessed ?? 0) === (best.lastAccessed ?? 0) && t.index > best.index) ? t : best));
  };

  // The window a named space lives in: the one Vivaldi's record shows it in; a parked space (shown nowhere) lives where
  // most of its tabs are, the lowest window id on a tie; one with no tabs lives nowhere (null). The default space (0)
  // is every window's own, so it lives nowhere. tabs: every tab in every normal window; record: Map spaceId -> windowId.
  const livesIn = (tabs, record, id) => {
    if (!id) return null;
    if (record?.has(id)) return record.get(id);
    const counts = new Map();
    for (const t of tabs || []) if (of(t) === id) counts.set(t.windowId, (counts.get(t.windowId) || 0) + 1);
    let best = null;
    for (const [windowId, n] of counts) {
      if (best === null || n > counts.get(best) || (n === counts.get(best) && windowId < best)) best = windowId;
    }
    return best;
  };

  // The window currently showing a named space, or null (parked). Vivaldi's record decides; only when the record cannot
  // be found (record null) does the window whose active tab is in the space stand in. activeTabs: one per window.
  const shownIn = (activeTabs, record, id) => {
    if (!id) return null;
    if (record) return record.get(id) ?? null;
    return (activeTabs || []).find((t) => of(t) === id)?.windowId ?? null;
  };

  // The spaces that live in a window other than `here`, shown or parked: the dots on the space bar, sorted.
  const dotsFor = (tabs, record, here) => {
    const ids = new Set([...(record?.keys() || []), ...(tabs || []).map(of)]);
    return [...ids].filter((id) => {
      const home = livesIn(tabs, record, id);
      return home !== null && home !== here;
    }).sort((a, b) => a - b);
  };

  // What a gesture on a space tile does (spec: "Gestures on a space tile"). A plain click never moves tabs between
  // windows on purpose: it shows the space here, focuses the window showing it, or sends the window that holds it to
  // it. The one exception: on a space split across windows, showing it gathers every tab into the window it lives in
  // (Vivaldi's switch moves them all), as repair 3 would.
  // Pure. tabs: every tab in every normal window (the active ones carry `active`); record: Map spaceId -> windowId,
  // empty when Vivaldi's record can't be read, in which case the active tabs stand in for it (as shownIn does).
  // -> { kind: "none"|"show"|"focus"|"show-there"|"pull"|"new-window", window?: number }
  const tileAction = ({ id, here, tabs, record, shift, newWindow }) => {
    const known = !!record && record.size > 0;
    if (!id) {
      if (newWindow) return { kind: "none" }; // the default space belongs to each window
      const shownHere = known ? ![...record.values()].includes(here)
        : (tabs || []).some((t) => t.active && t.windowId === here && of(t) === 0);
      return { kind: shownHere ? "none" : "show" };
    }
    if (newWindow) return { kind: "new-window" };
    const shown = shownIn(known ? [] : (tabs || []).filter((t) => t.active), known ? record : null, id);
    if (shown === here) return { kind: "none" };
    const home = shown ?? livesIn(tabs, known ? record : new Map(), id);
    if (home === null || home === here) return { kind: "show" };
    if (shift) return { kind: "pull" };
    return shown !== null ? { kind: "focus", window: home } : { kind: "show-there", window: home };
  };

  // Favorites and pinned tabs open in the space on screen (spec: "Favorites and pinned tabs"). tab: the tab bound to the
  // pin or favorite wherever it is (any window, any space), or null; here: this window's id; shown: the space this window
  // shows. -> { kind: "activate"|"bring"|"open", tab?: number }. A bound tab elsewhere is brought here, never activated
  // where it is: activating a tab of another space is what makes Vivaldi's record follow it (G1).
  const pinAction = (tab, here, shown) => {
    if (!tab) return { kind: "open" };
    return { kind: tab.windowId === here && of(tab) === shown ? "activate" : "bring", tab: tab.id };
  };

  // A tab picked in the command bar, which lists every tab of its window, parked ones included. Activating a parked tab
  // leaves the record where it was (G1) and repair 2 would snap the window back, so the tab's space is shown first.
  // tab: the picked tab; shown: the space its window's record names, or null when the record can't be read; shownIn:
  // the window the record shows the tab's space in, or null. -> { kind: "activate" } (its space is on screen, or no
  // record: activate as before), { kind: "switch", window, space } (parked in its window: Vivaldi's switch shows the
  // space, A3, then the tab is activated) or { kind: "focus", window } (its space is shown in another window, so the tab
  // is a split space's stray: go there as a tile click does, and repair 3 gathers it).
  const tabPick = (tab, shown, shownIn) => {
    const space = of(tab);
    if (shown == null || space === shown) return { kind: "activate" };
    if (space && shownIn != null && shownIn !== tab.windowId) return { kind: "focus", window: shownIn };
    return { kind: "switch", window: tab.windowId, space };
  };

  // Of the tabs bound to one pin, the one to use: already here and in the shown space, else the most recently used.
  const pickBound = (tabs, here, shown) => {
    const rank = (t) => (t.windowId === here && of(t) === shown ? 1 : 0);
    return (tabs || []).reduce((best, t) => (!best || rank(t) > rank(best) ||
      (rank(t) === rank(best) && (t.lastAccessed ?? 0) > (best.lastAccessed ?? 0)) ? t : best), null);
  };

  // The tab's vivExtData with its space set to `shown`, every other key kept. For the default space (0) the value is 0,
  // not an absent key: measured in the sandbox, chrome.tabs.update MERGES vivExtData, so a write without workspaceId
  // leaves the old space in place, while workspaceId: 0 makes Vivaldi drop the key (the tab then reads as default).
  const restamp = (tab, shown) => {
    let data = {};
    try { data = JSON.parse(tab?.vivExtData || "{}") || {}; } catch (_) {}
    data.workspaceId = shown || 0;
    return JSON.stringify(data);
  };

  // The vivExtData of a tab that leaves its window: in `space` (default 0), out of its split view (tiling) and its folder
  // (group, fixedGroupTitle), every other key kept. For a tear-off (default space) and a drop into another window (the
  // space that window shows). chrome.tabs.update merges vivExtData and only drops a key written as null (measured), so
  // the keys the tab has are nulled; a key it never had is not written.
  const tornData = (tab, space = 0) => {
    let data = {};
    try { data = JSON.parse(tab?.vivExtData || "{}") || {}; } catch (_) {}
    data.workspaceId = space || 0;
    for (const key of ["tiling", "group", "fixedGroupTitle"]) if (key in data) data[key] = null;
    return JSON.stringify(data);
  };

  // A tab row dragged from one window's sidebar into another's (Byron, 2026-11-08). dragstart writes DRAG_TYPE =
  // {kind:"tab", tabId, windowId}; HTML5 drag data crosses windows. raw: what the type holds, here: this window's id.
  // -> { tabId, windowId } for a tab of ANOTHER window, else null (a drag from this window takes the in-window path;
  // anything malformed or not a tab is ignored).
  const DRAG_TYPE = "application/x-vivarc-tab";
  const crossDrop = ({ raw, here } = {}) => {
    let data = null;
    try { data = JSON.parse(raw); } catch (_) { return null; }
    if (!data || typeof data !== "object" || data.kind !== "tab") return null;
    if (!Number.isInteger(data.tabId) || !Number.isInteger(data.windowId) || data.windowId === here) return null;
    return { tabId: data.tabId, windowId: data.windowId };
  };
  // Where a tab from another window lands beside `row` ({ index }): the list shows the highest index first, so above the
  // row is the next index up. The middle of a row makes no folder across windows: the nearer edge counts (t: 0..1 down it).
  const acrossIndex = (row, zone) => (zone === "before" ? row.index + 1 : row.index);
  const acrossZone = (t) => (t < 0.5 ? "before" : "after");

  // Dragging a tab row out of the sidebar past the window's edge opens it in a new window (Byron, 2026-11-08).
  // point: where the drag ended and bounds: the window, both in screen pixels; screen: the display's size. -> the new
  // window's {left, top} (about the drop point, kept on screen), or null when the drag stays: it ended on the window
  // (edge included), a drop target took it (dropEffect other than "none"), it is not a tab row, or it is the window's
  // only tab. Unknown numbers never tear off.
  const tearOff = (args) => {
    const { point, bounds, screen, tabCount, kind, dropEffect } = args || {};
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const x = num(point?.x), y = num(point?.y);
    const L = num(bounds?.left), T = num(bounds?.top), W = num(bounds?.width), H = num(bounds?.height);
    if (x === null || y === null || L === null || T === null || W === null || H === null) return null;
    if (x === 0 && y === 0) return null; // what a dragend with no known position reports, not a drop in a corner
    if (kind !== "tab" || !(tabCount > 1) || dropEffect !== "none") return null;
    if (x >= L && x <= L + W && y >= T && y <= T + H) return null;
    // Kept on the display when it is known (its origin may be negative on a second monitor); else left to the browser.
    const sl = num(screen?.left) ?? 0, st = num(screen?.top) ?? 0, sw = num(screen?.width), sh = num(screen?.height);
    const fit = (v, lo, size, room) => (size === null ? Math.round(v) : Math.round(Math.max(lo, Math.min(v, lo + size - room))));
    return { left: fit(x - 40, sl, sw, 120), top: fit(y - 20, st, sh, 80) };
  };

  // The one window that runs repairs: every window runs its own copy of Vivarc and sees every window's tabs, so they all
  // agree on the lowest normal window id. When it closes, the next lowest takes over. null when no normal window is left.
  const leaderOf = (windows) => (windows || []).filter((w) => w.type === "normal")
    .reduce((best, w) => (best === null || w.id < best ? w.id : best), null);

  // What puts the invariants back when Vivaldi breaks them (spec Part 2, "Repairs"), in the spec's order. Pure.
  // windows: chrome.windows; tabs: every tab in every normal window; record: Map spaceId -> windowId (Vivaldi's);
  // spaces: the ids of the spaces that exist, or null when the list can't be read (then no space counts as deleted).
  // -> [{kind:"switch", window, space} | {kind:"activate", tab} | {kind:"gather", space, window, tabs}], in the order
  // to carry them out. Each step is planned on the record the steps before it leave, so the plan's own result needs no
  // repair (Part 1's effects), with one exception noted at rule 2.
  const repairPlan = ({ windows, tabs, record, spaces }) => {
    const normal = (windows || []).filter((w) => w.type === "normal").map((w) => w.id).sort((a, b) => a - b);
    const live = new Set(normal);
    const all = (tabs || []).filter((t) => live.has(t.windowId));
    const held = (w, id) => all.filter((t) => t.windowId === w && of(t) === id);
    const known = Array.isArray(spaces) ? new Set(spaces) : null;
    // the record as the plan so far leaves it: named spaces only, in windows that are still open
    const shown = new Map([...(record || [])].filter(([id, w]) => id && live.has(w)));
    const recordedIn = (w) => [...shown].find(([, x]) => x === w)?.[0] ?? 0;
    const plan = [];

    // 1. A record on a deleted space, or on a space with no tab in its window (F2, C3, D1): the window goes to default,
    //    which activates its default tab (A8a, A8b), so rule 2 has nothing left to do there.
    const toDefault = new Set();
    for (const [id, w] of [...shown].sort((a, b) => a[1] - b[1])) {
      if ((known && !known.has(id)) || !held(w, id).length) {
        plan.push({ kind: "switch", window: w, space: 0 });
        shown.delete(id);
        toDefault.add(w);
      }
    }

    // 2. The active tab is in another space than the record (G1-G3): the recorded space's most recent tab comes back.
    //    Only a window on default can hold no tab of its space here (rule 1 took the rest); then the record follows
    //    the active tab, unless that space is shown in another window (G6). A switch to default would then do nothing
    //    (A8c) and a switch to it would only focus that window (A2), so nothing is switched: rule 3 gathers the tab
    //    where its space is shown, and what the window shows next is Vivaldi's pick, for the next pass.
    const pulled = new Set();
    for (const w of normal) {
      if (toDefault.has(w)) continue;
      const active = all.find((t) => t.windowId === w && t.active);
      if (!active) continue;
      const own = recordedIn(w), space = of(active);
      if (space === own) continue;
      const back = recentTab(held(w, own), own);
      if (back) plan.push({ kind: "activate", tab: back.id });
      else if (!shown.has(space)) {
        // Vivaldi's switch moves every tab of the space here (A4, A6), so rule 3 has nothing to gather for it
        plan.push({ kind: "switch", window: w, space });
        shown.set(space, w);
        pulled.add(space);
      }
    }

    // 3. A named space with tabs in more than one window (D8): its strays move to where it lives, the window showing
    //    it, else the one with most of its tabs (livesIn). They keep their space (C1).
    const named = [...new Set(all.map(of))].filter((id) => id && !pulled.has(id)).sort((a, b) => a - b);
    for (const id of named) {
      const own = all.filter((t) => of(t) === id);
      if (new Set(own.map((t) => t.windowId)).size < 2) continue;
      const home = livesIn(own, shown, id);
      const strays = own.filter((t) => t.windowId !== home).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
      plan.push({ kind: "gather", space: id, window: home, tabs: strays.map((t) => t.id) });
    }
    return plan;
  };

  // A click on a tile that sends its space to a new window: ctrl+shift on Windows, cmd+shift on a Mac.
  const wantsNewWindow = (event, windows = window.__vm.windows) =>
    !!event?.shiftKey && !!(windows ? event.ctrlKey : event.metaKey);

  // A space tile's tooltip: what this space is, and what clicking it does. Sending it to a new window is
  // ctrl+shift+click on Windows and cmd+shift+click on a Mac, where ctrl+click is a right-click.
  const tileHint = (item, livesElsewhere, windows = window.__vm.windows) => {
    if (!item.id) return `${item.name} · this window's own tabs`;
    const toNew = `${windows ? "ctrl" : "cmd"}+shift+click to move it to a new window`;
    if (livesElsewhere) {
      return `${item.name} · lives in another window. Click to go there, shift+click to bring it here, ${toNew}`;
    }
    return `${item.name} · ${toNew}`;
  };

  const label = (folder) => folder.title.startsWith(ARC_PREFIX) ? folder.title.slice(ARC_PREFIX.length) : folder.title;
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // folders: every bookmark folder that holds a Pinned folder, in bookmark order. A workspace takes the folder with
  // its name; the default space is the first folder nobody claims (the only one, if all are claimed).
  const assign = (folders, list) => {
    const byId = {};
    const used = new Set();
    for (const w of list || []) {
      const found = folders.find((f) => !used.has(f.id) && same(label(f), w.name));
      if (found) { byId[w.id] = found; used.add(found.id); }
    }
    return { default: folders.find((f) => !used.has(f.id)) ?? folders[0] ?? null, byId };
  };

  // Where a new tab (Ctrl+T, + New Tab) goes so it tops its space's list, as in Arc. The list shows the highest tab
  // index first (stacks.entries), so that is the index of the space's last unpinned tab in this window: chrome.tabs.move
  // to it puts the new tab just after that one. null when it is already there (or alone), so nothing moves.
  const topIndex = (tabs, tab) => {
    const space = of(tab);
    const last = tabs
      .filter((t) => t.windowId === tab.windowId && !t.pinned && of(t) === space)
      .reduce((best, t) => (best == null || t.index > best.index ? t : best), null);
    return last && last.id !== tab.id ? last.index : null;
  };

  // A mod can neither create a workspace (Vivaldi reads its list once) nor press a shortcut for the user: events a
  // mod dispatches never reach Vivaldi's shortcut handler. So the install binds "Create New Workspace" to this chord,
  // and the + tile and the command bar tell the user to press it.
  const CREATE_KEY = window.__vm.shortcut?.("ctrl+meta+n") || "ctrl+meta+n";
  const KEY_NAMES = { ctrl: "Ctrl", meta: "Cmd", alt: window.__vm.windows ? "Alt" : "Option", shift: "Shift" };
  const CREATE_HINT = `Press ${CREATE_KEY.split("+").map((k) => KEY_NAMES[k] || k.toUpperCase()).join("+")} to create a space`;

  // Vivaldi has no extension API to delete a workspace, only its own store. Its webpack chunk array lives on the
  // background page (chrome.extension.getBackgroundPage), not on the window the mod runs in, and its push hands out the module
  // list; the module that defines removeWorkspace is found by its source and loaded
  // only if it already ran. Returns (windowId, id) => Promise, or null when Vivaldi no longer looks like this.
  const findRemover = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes("removeWorkspace(")) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const key of Object.keys(exported || {})) {
          const manager = exported[key];
          if (typeof manager?.removeWorkspace === "function") return (windowId, workspaceId) => manager.removeWorkspace(windowId, workspaceId);
        }
      }
    } catch (_) {}
    return null;
  };

  // Reuse Vivaldi's own dialog so naming, icons and workspace creation remain native.
  const findCreator = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc-create-space")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes("showWorkspaceDialog(")) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const manager of Object.values(exported || {})) {
          if (typeof manager?.showWorkspaceDialog === "function") {
            return (windowId) => manager.showWorkspaceDialog(windowId, { createInBackground: false });
          }
        }
      }
    } catch (_) {}
    return null;
  };

  const findSwitcher = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc-switch-space")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes("setActiveWorkspace")) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const manager of Object.values(exported || {})) {
          if (typeof manager?.setActiveWorkspace === "function") {
            return (windowId, workspaceId) => manager.setActiveWorkspace(windowId, workspaceId || undefined);
          }
        }
      }
    } catch (_) {}
    return null;
  };

  // Vivaldi's own "move these tabs to a space" (PageActions.moveToWorkspace, what its keyboard shortcut runs). It reads
  // only the page's id and windowId, and a single page is wrapped into its list by Vivaldi itself, so `{ id, windowId }`
  // stands in for a page. The windowId given is the window Vivaldi moves the tab into: for a space shown in another
  // window it must be that window (asked from the tab's own window, the move fails: "ambiguous windowId"). The default
  // space is 0, as Vivaldi passes it (workspaceId: t || 0).
  const findMover = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc-move-space")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes('debug:"PageActions.moveToWorkspace"')) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const actions of Object.values(exported || {})) {
          if (typeof actions?.moveToWorkspace === "function") {
            return (pages, workspaceId) => actions.moveToWorkspace(pages, workspaceId || 0);
          }
        }
      }
    } catch (_) {}
    return null;
  };

  // The spaces a tab can move to: every space but the one on screen, the default included, in the sidebar's tile order.
  // items: what `items` returns.
  const moveTargets = (list, shownId) =>
    (list || []).filter((s) => s.id !== shownId).map((s) => ({ id: s.id, name: s.name }));

  // The New Tab row's dropdown (Task 8k).
  // "Open Tabs": the tabs grouped by window, then space. This window comes first, the others by id; within a window the
  // default space leads, then the spaces in `list`'s order (a space the list does not know goes last, still shown), and
  // within a group the tabs in window order. Headings are the space's name alone when there is one window, else
  // "This window · Work" / "Window 2 · Work" (the number is the window's place among the windows listed, by id).
  // -> [{ window, space, heading, tabs }]
  const openTabGroups = (tabs, list, here, defaultName = "Home") => {
    const all = tabs || [];
    const windows = [...new Set(all.map((t) => t.windowId))].sort((a, b) => a - b);
    const names = new Map([[0, defaultName], ...(list || []).map((s) => [s.id, s.name])]);
    const order = [0, ...(list || []).map((s) => s.id)];
    const place = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
    const out = [];
    for (const window of [...windows.filter((w) => w === here), ...windows.filter((w) => w !== here)]) {
      const mine = all.filter((t) => t.windowId === window);
      const spaces = [...new Set(mine.map(of))].sort((a, b) => place(a) - place(b) || a - b);
      for (const space of spaces) {
        const name = names.get(space) ?? "Space";
        const heading = windows.length === 1 ? name : `${window === here ? "This window" : `Window ${windows.indexOf(window) + 1}`} · ${name}`;
        out.push({ window, space, heading, tabs: mine.filter((t) => of(t) === space).sort((a, b) => a.index - b.index) });
      }
    }
    return out;
  };
  // "Mute All Tabs" flips to "Unmute All Tabs" once every listed tab is muted.
  const muteAllLabel = (tabs) => ((tabs || []).length && tabs.every((t) => t.mutedInfo?.muted) ? "Unmute All Tabs" : "Mute All Tabs");
  // chrome.sessions.getRecentlyClosed -> the entries the dropdown lists, newest first (the API's order), each with a
  // sessionId (restorable). A closed tab shows its title, else its address.
  const closedTabs = (sessions, max = 10) => (sessions || []).filter((s) => s.tab?.sessionId)
    .map((s) => ({ sessionId: s.tab.sessionId, title: s.tab.title || s.tab.url || "Untitled", url: s.tab.url || "", favIconUrl: s.tab.favIconUrl || "" }))
    .slice(0, max);
  // "2 tabs — First title": the count is what the entry holds, which is what comes back (measured: Vivaldi has rehomed a
  // closing window's named-space tabs by then, so an entry holds that window's default-space tabs only).
  const closedWindowLabel = (entry, cut = 30) => {
    const tabs = entry?.tabs || [];
    const noun = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
    const first = tabs[0] && (tabs[0].title || tabs[0].url);
    if (!first) return noun;
    return `${noun} — ${first.length > cut ? `${first.slice(0, cut - 1).trimEnd()}…` : first}`;
  };
  const closedWindows = (sessions, max = 10) => (sessions || []).filter((s) => s.window?.sessionId)
    .map((s) => ({ sessionId: s.window.sessionId, count: (s.window.tabs || []).length, label: closedWindowLabel(s.window) }))
    .slice(0, max);
  // The confirmation for "Close All Tabs": the loose tabs that Clear closes; tab folders stay.
  const closeAllLabel = (count, folders = 0) => `Close ${count} tab${count === 1 ? "" : "s"}${folders ? " (folders stay)" : ""}`;

  // Vivaldi's record of which space each window shows (its workspace store): activeIn(windowId) is that space's id, 0
  // for the default space (a window with no entry); all() maps each recorded space's id to the window showing it.
  // Null when the store is not found, and the caller decides what to fall back to.
  const findRecord = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc-record")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!/getActiveWorkspaceId\([\w$]+\)\{/.test(String(factory))) continue; // its definition, whatever the minifier named its parameter
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const store of Object.values(exported || {})) {
          if (typeof store?.getActiveWorkspaceId === "function" && typeof store?.getActiveWorkspaces === "function") {
            // A store that throws, or answers with something odd, after a successful lookup gives null (activeIn)
            // or an empty map (all), so the caller falls back instead of throwing into the UI.
            return {
              activeIn: (windowId) => {
                try {
                  const space = store.getActiveWorkspaceId(windowId) ?? 0;
                  return typeof space === "number" ? space : null;
                } catch (_) { return null; }
              },
              all: () => {
                try { return new Map([...store.getActiveWorkspaces()].filter(([space]) => space != null)); } catch (_) { return new Map(); }
              },
            };
          }
        }
      }
    } catch (_) {}
    return null;
  };

  // What deleting space `id` closes, given every normal window's tabs: how many tabs, in how many windows, and
  // whether some window holds nothing else (so it closes too).
  const removalScope = (tabs, id) => {
    const byWindow = new Map();
    for (const t of Array.isArray(tabs) ? tabs : []) {
      const w = byWindow.get(t.windowId) || { all: 0, mine: 0 };
      w.all += 1;
      if (of(t) === id) w.mine += 1;
      byWindow.set(t.windowId, w);
    }
    const holding = [...byWindow.values()].filter((w) => w.mine > 0);
    return {
      tabCount: holding.reduce((n, w) => n + w.mine, 0),
      windowCount: holding.length,
      closesWindow: holding.some((w) => w.mine === w.all),
    };
  };

  const removalLabel = (name, tabCount, windowCount = 1, closesWindow = false) => {
    let label = `Delete \u201c${name}\u201d`;
    if (!tabCount) return label;
    label += ` and close its ${tabCount} ${tabCount === 1 ? "tab" : "tabs"}`;
    if (windowCount > 1) label += ` in ${windowCount} windows`;
    if (closesWindow) label += ". A window holding only these tabs closes too";
    return label;
  };

  // The window a chrome.tabs event (its name and arguments) belongs to, or undefined when the event does not say.
  const eventWindow = (ev, [first, second, third] = []) => ({
    onCreated: first?.windowId, onUpdated: third?.windowId, onActivated: first?.windowId,
    onRemoved: second?.windowId, onMoved: second?.windowId, onAttached: second?.newWindowId, onDetached: second?.oldWindowId,
  })[ev];

  window.__vm.workspaces = { of, tabsIn, activeId, scope, items, recentTab, livesIn, shownIn, dotsFor, tileAction, pinAction, tabPick, pickBound, restamp, tornData, DRAG_TYPE, crossDrop, acrossIndex, acrossZone, tearOff, leaderOf, repairPlan, wantsNewWindow, tileHint, topIndex, label, assign, findRemover, findCreator, findSwitcher, findRecord, findMover, moveTargets, openTabGroups, muteAllLabel, closedTabs, closedWindows, closedWindowLabel, closeAllLabel, removalScope, removalLabel, eventWindow, CREATE_HINT };
})();
