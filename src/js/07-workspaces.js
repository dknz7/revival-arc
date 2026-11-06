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

  // Vivaldi's record of which space each window shows (its workspace store): activeIn(windowId) is that space's id, 0
  // for the default space (a window with no entry); all() maps each recorded space's id to the window showing it.
  // Null when the store is not found, and the caller decides what to fall back to.
  const findRecord = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc-record")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes("getActiveWorkspaceId(e){")) continue;
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

  const removalLabel = (name, tabCount) =>
    `Delete \u201c${name}\u201d${tabCount ? ` and close its ${tabCount} ${tabCount === 1 ? "tab" : "tabs"}` : ""}`;

  // The window a chrome.tabs event (its name and arguments) belongs to, or undefined when the event does not say.
  const eventWindow = (ev, [first, second, third] = []) => ({
    onCreated: first?.windowId, onUpdated: third?.windowId, onActivated: first?.windowId,
    onRemoved: second?.windowId, onMoved: second?.windowId, onAttached: second?.newWindowId, onDetached: second?.oldWindowId,
  })[ev];

  window.__vm.workspaces = { of, tabsIn, activeId, scope, items, recentTab, livesIn, shownIn, dotsFor, wantsNewWindow, tileHint, topIndex, label, assign, findRemover, findCreator, findSwitcher, findRecord, removalLabel, eventWindow, CREATE_HINT };
})();
