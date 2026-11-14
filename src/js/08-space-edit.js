// Editing a space and bringing a deleted one back (Task 9c; edit is upstream KASOGIT/vivarc#126, by gulin-desigenr).
// Vivaldi has no extension API for its workspaces, only its own manager, found in its webpack modules like findRemover
// (07-workspaces.js) by a marker in its source. Measured in Vivaldi 8.3.4191.30's bundle.js:
// - the manager: addWorkspaceWithId(id, name, icon, emoji) (re-creates a space with a given id: every tab still carrying
//   it is that space's again, task 8y), addWorkspace(name, icon, emoji, pages, background) (id = Date.now(); it switches
//   the last active window to it unless `background`), setName(id, name), setIcon(id, i) (i: one of Vivaldi's 20 icons;
//   it clears the emoji), setEmoji(id, emoji), setOrder(ids) (ignored unless it names every space), removeWorkspace;
// - link routing rules: the pref vivaldi.workspaces.link_routes, [{ id, type, expression, workspaceId }]; Vivaldi's
//   removeWorkspace deletes a space's rules first (removeWorkspaceRules), so they are read before; its route manager
//   adds one back with addLinkRoutingRule(type, expression, workspaceId);
// - the 20 icons: an array exported by the module that defines the workspace store's getRandomIcon.
// Vivarc still never writes a workspace pref: every change goes through Vivaldi's own store, which writes the pref.
//
// Undelete: Vivarc's delete (10-sidebar.js deleteSpace) first stores what the space was under `deletedSpaces` (the key
// the heal skips, 11-space-repair.js), reads it back, and only then lets Vivaldi delete; right after, it notes each
// tab's Recently Closed entry. The New Tab menu's Recently Deleted Spaces brings an entry back. Pure parts first (tested,
// tests/test_space_edit.py), then the parts that talk to Vivaldi.
(() => {
  const ws = () => window.__vm.workspaces;
  const DELETED_KEY = "deletedSpaces";
  const KEEP_MS = 30 * 24 * 3600 * 1000; // an entry is kept 30 days
  const KEEP_MAX = 10; // the last 10 deleted spaces
  const MATCH_SLACK_S = 5; // a Recently Closed entry this many seconds older than the delete is not the delete's
  const THEME_KEY = (id) => `theme:space:${id}`; // 40-theme.js keys a space's theme by its id

  const extOf = (tab) => { try { const d = JSON.parse(tab?.vivExtData || "{}"); return d && typeof d === "object" ? d : {}; } catch (_) { return {}; } };

  // ---- pure: what is remembered ----
  // The entry for space `space` ({ id, name, emoji, icon, iconId }), deleted at `now`. list: Vivaldi's spaces in order;
  // tabs: every normal window's tabs; record: Map spaceId -> windowId (Vivaldi's, or null); rules: the link routes;
  // theme: the space's stored theme or null. Its blank tabs (a start page an empty space keeps) are not remembered.
  // -> { v, id, name, emoji, icon, iconId, position, after, before, rules, window, shown, deletedAt, theme, tabs }
  const deletedEntry = ({ space, list, tabs, record, rules, theme = null, now }) => {
    const id = space.id;
    const ids = (list || []).map((w) => w.id);
    const at = ids.indexOf(id);
    const of = ws().of, isBlank = ws().isBlank;
    const own = (tabs || []).filter((t) => of(t) === id && !isBlank(t)).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    return {
      v: 1, id, name: space.name || "", emoji: space.emoji || "", icon: space.icon || "",
      iconId: Number.isInteger(space.iconId) ? space.iconId : null,
      position: at, after: at > 0 ? ids[at - 1] : null, before: at >= 0 && at + 1 < ids.length ? ids[at + 1] : null,
      rules: (rules || []).filter((r) => r && r.workspaceId === id && r.type && typeof r.expression === "string").map((r) => ({ type: r.type, expression: r.expression })),
      window: ws().livesIn(tabs, record || new Map(), id), shown: record?.get?.(id) != null,
      deletedAt: now, theme: theme ?? null,
      tabs: own.map((t) => {
        const d = extOf(t);
        return { url: t.pendingUrl || t.url || "", title: t.title || "", favIconUrl: t.favIconUrl || "", index: t.index, windowId: t.windowId,
          pinned: !!t.pinned, muted: !!t.mutedInfo?.muted, group: d.group ?? null, fixedGroupTitle: d.fixedGroupTitle ?? null,
          tiling: d.tiling ?? null, vivarcPin: d.vivarcPin ?? null, sessionId: null };
      }).filter((t) => t.url),
    };
  };
  const valid = (e) => !!e && typeof e === "object" && Number.isFinite(e.id) && e.id > 0 && Number.isFinite(e.deletedAt) && Array.isArray(e.tabs);
  const sameDeleted = (a, b) => !!a && !!b && a.id === b.id && a.deletedAt === b.deletedAt;
  // The list after `added` joins `list`: newest first, one entry per space id (the newest), nothing older than 30 days,
  // at most 10 (the oldest go), anything malformed dropped.
  const keepDeleted = (list, added, now) => {
    const all = [...(added || []), ...(list || [])].filter((e) => valid(e) && now - e.deletedAt <= KEEP_MS)
      .map((e, i) => [e, i]).sort((a, b) => b[0].deletedAt - a[0].deletedAt || a[1] - b[1]).map(([e]) => e);
    const seen = new Set();
    return all.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).slice(0, KEEP_MAX);
  };
  // What the heal may not touch: the entries undelete can still bring back (an expired one's tabs heal again).
  const held = (list, now) => keepDeleted(Array.isArray(list) ? list : [], [], now);

  // Each remembered tab's Recently Closed entry (chrome.sessions.getRecentlyClosed, newest first): the same address, the
  // same title first, closed no earlier than `since` (ms) less a few seconds; each entry is used once. -> the tabs, with
  // sessionId where one was found (a tab already holding a listed id keeps it).
  const matchSessions = (tabs, sessions, since) => {
    const pool = (sessions || []).filter((s) => s?.tab?.sessionId && (!Number.isFinite(since) || !Number.isFinite(s.lastModified) || s.lastModified >= since / 1000 - MATCH_SLACK_S));
    const used = new Set();
    const out = (tabs || []).map((t) => ({ ...t }));
    for (const t of out) if (t.sessionId && pool.some((s) => s.tab.sessionId === t.sessionId)) used.add(t.sessionId);
    for (const strict of [true, false]) {
      for (const t of out) {
        if (t.sessionId && used.has(t.sessionId)) continue;
        const s = pool.find((x) => !used.has(x.tab.sessionId) && x.tab.url === t.url && (!strict || (x.tab.title || "") === (t.title || "")));
        if (s) { t.sessionId = s.tab.sessionId; used.add(s.tab.sessionId); }
      }
    }
    for (const t of out) if (t.sessionId && !used.has(t.sessionId)) t.sessionId = null;
    return out;
  };

  // ---- pure: bringing it back ----
  // Where its id goes in the list: before the space that followed it, else after the one before it, else at its old
  // place (clamped). ids: the list as it is now (with or without the id). -> the new list, or null when nothing changes.
  const orderAfter = (ids, entry) => {
    const rest = (ids || []).filter((x) => x !== entry.id);
    let at;
    if (entry.before != null && rest.includes(entry.before)) at = rest.indexOf(entry.before);
    else if (entry.after != null && rest.includes(entry.after)) at = rest.indexOf(entry.after) + 1;
    else at = Math.max(0, Math.min(Number.isInteger(entry.position) && entry.position >= 0 ? entry.position : rest.length, rest.length));
    const next = [...rest.slice(0, at), entry.id, ...rest.slice(at)];
    return JSON.stringify(next) === JSON.stringify(ids || []) ? null : next;
  };
  // How the entry comes back. windows: the normal windows' ids; here: the window asking; sessions: Recently Closed now.
  // -> { window: its old window while it is open, else here; tabs: in their old order, each { how: "session", sessionId }
  // (still listed, by its id or, after a restart gave the entries new ids, by address and title) or { how: "create" } }
  const restorePlan = ({ entry, windows, here, sessions }) => {
    const window = (windows || []).includes(entry.window) ? entry.window : here;
    const ordered = [...(entry.tabs || [])].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    // the tabs of the target window keep their order; tabs that lived elsewhere (a split, 8.2) follow it
    const sorted = [...ordered.filter((t) => t.windowId === window), ...ordered.filter((t) => t.windowId !== window)];
    const matched = matchSessions(sorted, sessions, entry.deletedAt);
    return { window, tabs: matched.map((t) => (t.sessionId ? { ...t, how: "session" } : { ...t, how: "create", sessionId: null })) };
  };
  // The order of a space's tabs is right when, read in window order, they come in the entry's order. got: the restored
  // tabs' ids in window order; want: the same ids in the entry's order. Pinned tabs keep Chromium's pinned area.
  const inOrder = (got, want) => JSON.stringify(got) === JSON.stringify(want);
  // "4 tabs · 2 days ago"
  const deletedNote = (entry, now) => {
    const n = (entry?.tabs || []).length;
    return `${n} tab${n === 1 ? "" : "s"} · ${ws().cleanedAgo(entry.deletedAt, now)}`;
  };

  // ---- pure: editing ----
  // Move a space one place left (-1) or right (+1) in Vivaldi's list. -> the new list, or null at the end.
  const moved = (ids, id, delta) => {
    const at = (ids || []).indexOf(id), to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return null;
    const next = [...ids];
    [next[at], next[to]] = [next[to], next[at]];
    return next;
  };
  // A name for a space made by +: "New Space", else "New Space 2", 3, ...
  const newSpaceName = (list, base = "New Space") => {
    const taken = new Set((list || []).map((w) => String(w.name || "").trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  };
  // Can space `id` be called `name`? A space takes its Pinned folder by name (07-workspaces.js assign), so a name another
  // space has, or another folder's, would hand it someone else's pins. folders: the bookmark folders that hold a Pinned
  // folder; list: Vivaldi's spaces. -> { name } (trimmed), { same: true } (unchanged), or { why }.
  const renameCheck = ({ name, id, list, folders }) => {
    const clean = String(name ?? "").trim();
    if (!clean) return { why: "A space needs a name" };
    const me = (list || []).find((w) => w.id === id);
    if (me && me.name === clean) return { same: true };
    const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
    if ((list || []).some((w) => w.id !== id && same(String(w.name || ""), clean))) return { why: `There is already a space called “${clean}”` };
    const mine = ws().assign(folders || [], list || []).byId[id] ?? null;
    if ((folders || []).some((f) => f.id !== mine?.id && same(ws().label(f), clean))) return { why: `“${clean}” is another space's Pinned folder` };
    return { name: clean };
  };
  // The space's bookmark folder title for its new name, keeping an "Arc - " prefix (upstream #126).
  const folderTitle = (title, name) => (String(title || "").startsWith("Arc - ") ? `Arc - ${name}` : name);

  // ---- Vivaldi's manager, routes and icons (kept once found, looked for at most every 5 s) ----
  // Vivaldi's webpack require, taken out of its chunk array again at once (07-workspaces.js requireOf explains why; this file
  // has its own copy, as 15-dia.js does, so it can be loaded on its own).
  const requireOf = (chunks, tag) => {
    let load;
    const entry = [[Symbol(tag)], {}, (require) => { load = require; }];
    chunks.push(entry);
    const at = typeof chunks.lastIndexOf === "function" ? chunks.lastIndexOf(entry) : -1;
    if (at >= 0) chunks.splice(at, 1);
    return load;
  };
  const chunkLists = () => { const out = [window.webpackChunkgapp_browser_react]; try { out.push(chrome.extension?.getBackgroundPage?.()?.webpackChunkgapp_browser_react); } catch (_) {} return out; };
  const findIn = (chunks, marker, pick, tag) => {
    try {
      const load = requireOf(chunks, tag);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes(marker)) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const value of Object.values(exported || {})) { const got = pick(value); if (got) return got; }
      }
    } catch (_) {}
    return null;
  };
  const MANAGER = ["addWorkspaceWithId", "addWorkspace", "setName", "setIcon", "setEmoji", "setOrder"];
  const findManager = (chunks) => findIn(chunks, "addWorkspaceWithId(", (v) => (MANAGER.every((k) => typeof v?.[k] === "function") ? v : null), "vivarc-space-manager");
  const findRoutes = (chunks) => findIn(chunks, "addLinkRoutingRule(", (v) => (typeof v?.addLinkRoutingRule === "function" ? v : null), "vivarc-space-routes");
  const findIcons = (chunks) => findIn(chunks, "getRandomIcon(){", (v) => (Array.isArray(v) && v.length > 1 && v.every((s) => typeof s === "string" && s.trim().startsWith("<svg")) ? v : null), "vivarc-space-icons");
  const lookup = (find) => {
    let found = null, lastTry = -Infinity;
    return () => {
      if (found) return found;
      if (Date.now() - lastTry < 5000) return null;
      lastTry = Date.now();
      for (const chunks of chunkLists()) { found = (chunks && find(chunks)) || null; if (found) break; }
      return found;
    };
  };
  const manager = lookup(findManager), routes = lookup(findRoutes), icons = lookup(findIcons);
  // Vivaldi's default workspace icon is the last of its 20 (its store's getDefaultIcon).
  const defaultIcon = () => { const all = icons(); return all ? all[all.length - 1] : ""; };

  // ---- the store (per profile): like Clean Up's (13-cleanup.js), a write is raced against a timeout and read back,
  // and changes run one after another across the profile's windows (a chain on the shared background page) ----
  const STORE_MS = 8000;
  const LOCK_MS = 20000;
  const QUEUE = "__vivarcDeletedQueue";
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
  const store = () => window.__vm.store;
  // A failed read rejects (store.read), so a broken store is never overwritten with an empty list.
  const load = async () => {
    const raw = await within(store().read(DELETED_KEY), STORE_MS, "reading the deleted spaces");
    if (raw !== undefined && !Array.isArray(raw)) throw new Error("the stored deleted spaces are not a list");
    return keepDeleted(raw ?? [], [], Date.now());
  };
  const list = () => load().catch((error) => { console.warn("[vivarc] deleted spaces: read:", error); return []; });
  const mutate = (change) => locked(async () => {
    const next = change(await load());
    await within(store().set(DELETED_KEY, next), STORE_MS, "writing the deleted spaces");
    return next;
  });
  const forget = (entry) => mutate((all) => all.filter((e) => !sameDeleted(e, entry)));

  const readPref = async (path) => { try { return (await vivaldi.prefs.get(path))?.value; } catch (_) { return undefined; } };
  const spaceList = async () => { const v = await readPref("vivaldi.workspaces.list"); return Array.isArray(v) ? v : null; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test, ms = 3000, every = 100) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await test()) return true;
    return !!(await test());
  };

  // Before Vivaldi deletes space `id`: its entry is written and READ BACK. -> the entry; throws when it is not in the
  // store (the caller then deletes nothing: the confirmation promised it can be undone).
  const remember = async (id) => {
    const all = await spaceList();
    const space = all?.find((w) => w.id === id);
    if (!space) throw new Error("the space is not in Vivaldi's list");
    const [tabs, rules, theme] = await Promise.all([chrome.tabs.query({ windowType: "normal" }), readPref("vivaldi.workspaces.link_routes"),
      store().get(THEME_KEY(id), null)]);
    const entry = deletedEntry({ space, list: all, tabs, record: window.__vm.native?.record()?.all() ?? null, rules: Array.isArray(rules) ? rules : [], theme, now: Date.now() });
    await mutate((now) => keepDeleted(now, [entry], Date.now()));
    if (!(await load()).some((e) => sameDeleted(e, entry))) throw new Error("the entry did not reach the store");
    return entry;
  };
  // Right after the delete: each tab's Recently Closed entry, so undelete can bring the tab back with its history.
  // Best effort (the address is the fallback); Vivaldi lists the closed tabs within a moment, so it looks twice.
  const noteClosed = async (entry) => {
    let tabs = entry.tabs;
    for (let look = 0; look < 2; look++) {
      await sleep(look ? 700 : 250);
      tabs = matchSessions(tabs, await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []), entry.deletedAt);
      if (tabs.every((t) => t.sessionId)) break;
    }
    if (!tabs.some((t) => t.sessionId)) return entry;
    const next = { ...entry, tabs };
    await mutate((all) => all.map((e) => (sameDeleted(e, entry) ? next : e)));
    return next;
  };

  // Brings `entry` back, from window `here`, under the repair busy mark: the space with its id (Vivaldi's store), its
  // place in the list, its link rules and theme; then each tab in order (Recently Closed while it is still listed: it comes
  // back with its history and its old id, now live again; else a new tab put into the space with native.setSpace), its
  // folder, split, pin and mute; the order checked; then the space is shown (in its old window while that is open, else
  // here) and the entry goes. Tabs still carrying the id (if any survived) are the space's again at once.
  // -> { window, space, tabs: how many came back }; throws when the space could not be made (the entry then stays).
  const restoring = new Set(); // a second click while one runs would open its tabs twice
  const undelete = async (entry, here) => {
    const mgr = manager();
    if (!mgr) throw new Error("Vivaldi's workspace manager was not found");
    const id = entry.id;
    if (restoring.has(id)) throw new Error("that space is already coming back");
    restoring.add(id);
    const native = window.__vm.native;
    const end = window.__vm.spaceRepair?.gesture?.() ?? null;
    try {
      // 1. the space, with its id
      if (!(await spaceList())?.some((w) => w.id === id)) {
        await mgr.addWorkspaceWithId(id, entry.name, entry.icon || defaultIcon(), entry.emoji || undefined);
        if (!entry.emoji && Number.isInteger(entry.iconId)) await mgr.setIcon(id, entry.iconId);
        if (!(await until(async () => (await spaceList())?.some((w) => w.id === id), 3000))) throw new Error("Vivaldi did not list the space again");
      }
      // 2. its place, rules and theme
      const order = orderAfter(((await spaceList()) || []).map((w) => w.id), entry);
      if (order) await mgr.setOrder(order);
      const router = routes();
      for (const r of entry.rules || []) await router?.addLinkRoutingRule(r.type, r.expression, id);
      if (entry.theme && (await store().get(THEME_KEY(id), null)) == null) await store().set(THEME_KEY(id), entry.theme);
      // 3. its tabs
      const windows = (await chrome.windows.getAll()).filter((w) => w.type === "normal").map((w) => w.id);
      const plan = restorePlan({ entry, windows, here, sessions: await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []) });
      const target = plan.window;
      const made = [];
      const splits = new Map();
      for (const t of plan.tabs) {
        let tab = null;
        if (t.how === "session") {
          try { tab = (await chrome.sessions.restore(t.sessionId))?.tab ?? null; } catch (_) { tab = null; }
          if (tab) tab = await chrome.tabs.get(tab.id).catch(() => null);
        }
        const fresh = !tab;
        if (fresh) tab = await chrome.tabs.create({ windowId: target, url: t.url, active: false, pinned: !!t.pinned }).catch(() => null);
        if (!tab) continue;
        try { if (ws().of(tab) !== id || tab.windowId !== target) await native.setSpace(tab.id, id, { windowId: target }); }
        catch (error) { console.warn("[vivarc] undelete: a tab did not go back into its space:", error); }
        if (fresh) {
          const patch = {};
          if (t.group) { patch.group = t.group; if (t.fixedGroupTitle) patch.fixedGroupTitle = t.fixedGroupTitle; }
          if (t.vivarcPin) patch.vivarcPin = t.vivarcPin;
          if (t.tiling?.id) { if (!splits.has(t.tiling.id)) splits.set(t.tiling.id, crypto.randomUUID?.() || `vm-${Date.now()}-${splits.size}`); patch.tiling = { ...t.tiling, id: splits.get(t.tiling.id) }; }
          if (Object.keys(patch).length) await window.__vm.setExtData(tab, patch).catch(() => {});
          if (t.muted) await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
        }
        made.push({ id: tab.id, pinned: !!t.pinned });
      }
      // the order: read in the window, the space's tabs must come as they were; else each unpinned one goes last, in order
      const inWindow = (await chrome.tabs.query({ windowId: target })).filter((t) => made.some((m) => m.id === t.id)).sort((a, b) => a.index - b.index).map((t) => t.id);
      const want = made.map((m) => m.id).filter((x) => inWindow.includes(x));
      if (!inOrder(inWindow, want)) {
        for (const m of made) if (!m.pinned && inWindow.includes(m.id)) await native.setSpace(m.id, id, { windowId: target, index: -1 }).catch(() => {});
      }
      // 4. shown, the entry gone
      await native.switchTo(target, id).catch((error) => console.warn("[vivarc] undelete: show the space:", error));
      if (target !== here) await native.focus(target).catch(() => {});
      await forget(entry).catch((error) => console.warn("[vivarc] undelete: forget the entry:", error));
      return { window: target, space: id, tabs: made.length };
    } finally { restoring.delete(id); end?.(); }
  };

  // ---- editing (the space tile's right-click menu, and +) ----
  // Renames space `id`: its Pinned folder FIRST, so its pins stay with it (upstream #126), then the space. While that
  // runs, no window makes the space an empty folder for a name that does not match yet (10-sidebar.js applySpace asks
  // renaming()). folder: its bookmark folder or null.
  const RENAME_MARK = "__vivarcSpaceRename";
  const renaming = (id) => { const m = page()[RENAME_MARK]; return !!m && m.until > Date.now() && (id == null || m.id === id); };
  const rename = async (id, name, folder) => {
    const mgr = manager();
    if (!mgr) throw new Error("Vivaldi's workspace manager was not found");
    page()[RENAME_MARK] = { id, until: Date.now() + 5000 };
    try {
      if (folder) await chrome.bookmarks.update(folder.id, { title: folderTitle(folder.title, name) });
      await mgr.setName(id, name);
      await until(async () => (await spaceList())?.find((w) => w.id === id)?.name === name, 3000);
    } finally { delete page()[RENAME_MARK]; }
  };
  const setOrder = async (ids) => { const mgr = manager(); if (!mgr) throw new Error("Vivaldi's workspace manager was not found"); await mgr.setOrder(ids); };
  const setIcon = async (id, index) => { const mgr = manager(); if (!mgr) throw new Error("Vivaldi's workspace manager was not found"); await mgr.setIcon(id, index); };
  const setEmoji = async (id, emoji) => { const mgr = manager(); if (!mgr) throw new Error("Vivaldi's workspace manager was not found"); await mgr.setEmoji(id, emoji || undefined); };
  // A new space at once, named and with Vivaldi's default icon, not shown (the empty space would open the command bar
  // over its rename). -> its id.
  const create = async (name) => {
    const mgr = manager();
    if (!mgr) throw new Error("Vivaldi's workspace manager was not found");
    const id = await mgr.addWorkspace(name, defaultIcon(), undefined, null, true);
    if (!(await until(async () => (await spaceList())?.some((w) => w.id === id), 3000))) throw new Error("Vivaldi did not list the new space");
    return id;
  };

  window.__vm.spaceEdit = {
    DELETED_KEY, KEEP_MS, KEEP_MAX, deletedEntry, keepDeleted, held, sameDeleted, matchSessions, orderAfter, restorePlan, inOrder, deletedNote,
    moved, newSpaceName, renameCheck, folderTitle, findManager, findRoutes, findIcons,
    manager, icons, list, remember, noteClosed, undelete, forget, rename, renaming, setOrder, setIcon, setEmoji, create,
  };
})();
