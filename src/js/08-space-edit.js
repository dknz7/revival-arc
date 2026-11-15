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
  // sessionId where one was found. A stored id is kept only while it is listed for the same address: Chromium numbers the
  // entries afresh each run, so after a restart an old id can name another closed tab.
  const matchSessions = (tabs, sessions, since) => {
    const pool = (sessions || []).filter((s) => s?.tab?.sessionId && (!Number.isFinite(since) || !Number.isFinite(s.lastModified) || s.lastModified >= since / 1000 - MATCH_SLACK_S));
    const used = new Set();
    const out = (tabs || []).map((t) => ({ ...t }));
    for (const t of out) {
      if (t.sessionId && !used.has(t.sessionId) && pool.some((s) => s.tab.sessionId === t.sessionId && s.tab.url === t.url)) used.add(t.sessionId);
      else t.sessionId = null;
    }
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
  // How the entry comes back. windows: the normal windows' ids; here: the window asking; sessions: Recently Closed now;
  // live: the tabs that carry the space's id right now (one Vivaldi brought back with it, or one an earlier, unfinished
  // undelete restored); sameRun: whether this browser run is the one that deleted it (window ids start afresh too).
  // -> { window: its old window while it is open in the same run, else here; tabs: in their old order, each
  // { how: "live", tab } (already back: never opened twice), { how: "session", sessionId } (still listed, by its id or,
  // after a restart, by address and title) or { how: "create" } }
  const restorePlan = ({ entry, windows, here, sessions, live = [], sameRun = true }) => {
    const window = sameRun && (windows || []).includes(entry.window) ? entry.window : here;
    const ordered = [...(entry.tabs || [])].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    // the tabs of the target window keep their order; tabs that lived elsewhere (a split, 8.2) follow it
    const sorted = [...ordered.filter((t) => t.windowId === window), ...ordered.filter((t) => t.windowId !== window)];
    const left = [...(live || [])];
    const back = sorted.map((t) => { const i = left.findIndex((x) => (x.pendingUrl || x.url) === t.url); return i < 0 ? null : left.splice(i, 1)[0]; });
    // only the tabs not already back are matched to Recently Closed
    const matched = matchSessions(sorted.filter((t, i) => !back[i]), sessions || [], entry.deletedAt);
    const plan = sorted.map((t, i) => {
      if (back[i]) return { ...t, how: "live", tab: back[i].id, sessionId: null };
      const m = matched.shift();
      return m.sessionId ? { ...m, how: "session" } : { ...m, how: "create", sessionId: null };
    });
    return { window, tabs: plan };
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
  // labels: the Pinned folders' names too, so a new space never takes a leftover folder's pins.
  const newSpaceName = (list, base = "New Space", labels = []) => {
    const taken = new Set([...(list || []).map((w) => String(w.name || "")), ...(labels || [])].map((n) => n.trim().toLowerCase()));
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
    const { default: base, byId } = ws().assign(folders || [], list || []);
    const mine = byId[id] ?? null;
    const other = (folders || []).find((f) => f.id !== mine?.id && same(ws().label(f), clean));
    if (other && other.id === base?.id) return { why: `“${clean}” is the default space's Pinned folder` };
    // a folder no space claims (a deleted space's, kept for undelete): two folders of one name would leave the pins to chance
    if (other) return { why: `A Pinned folder called “${clean}” is already in your bookmarks (a deleted space's?): rename or remove it first` };
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
  // A private window shares Vivaldi's space list with the profile, but has its own store and sees only its own tabs: an
  // undo entry written there would miss the normal windows' tabs and vanish with the window (review 9c, critical 1). So
  // nothing here edits, deletes, makes or brings back a space from a private window.
  const PRIVATE = "Edit, delete and bring back spaces from a normal window";
  const isPrivate = () => { try { return !!chrome.extension?.inIncognitoContext; } catch (_) { return false; } };
  const normalOnly = () => { if (isPrivate()) { const e = new Error(PRIVATE); e.code = "private"; throw e; } };
  // This browser run (window ids start afresh with each): a mark on the background page, which lives as long as Vivaldi.
  const RUN_KEY = "__vivarcRun";
  const runId = () => { const p = page(); if (!p[RUN_KEY]) p[RUN_KEY] = `${Date.now()}-${Math.random().toString(36).slice(2)}`; return p[RUN_KEY]; };
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
    normalOnly();
    const all = await spaceList();
    const space = all?.find((w) => w.id === id);
    if (!space) throw new Error("the space is not in Vivaldi's list");
    const [tabs, rules, theme] = await Promise.all([chrome.tabs.query({ windowType: "normal" }), readPref("vivaldi.workspaces.link_routes"),
      store().get(THEME_KEY(id), null)]);
    const entry = { ...deletedEntry({ space, list: all, tabs, record: window.__vm.native?.record()?.all() ?? null, rules: Array.isArray(rules) ? rules : [], theme, now: Date.now() }), run: runId() };
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
  // One undelete of a space at a time, in any window (a second click would open its tabs twice): a set on the shared page.
  const RESTORING = "__vivarcUndeleting";
  const restoring = () => { const p = page(); if (!(p[RESTORING] instanceof Set)) p[RESTORING] = new Set(); return p[RESTORING]; };
  const undelete = async (entry, here) => {
    normalOnly();
    const mgr = manager();
    if (!mgr) throw new Error("Vivaldi's workspace manager was not found");
    const id = entry.id;
    if (restoring().has(id)) throw new Error("that space is already coming back");
    restoring().add(id);
    const native = window.__vm.native;
    // The repair busy mark lasts 10 s at most: a big space takes longer, so it is renewed as each tab comes back.
    let end = window.__vm.spaceRepair?.gesture?.() ?? null;
    const renew = () => { const next = window.__vm.spaceRepair?.gesture?.() ?? null; end?.(); end = next; };
    try {
      // 1. the space, with its id
      if (!(await spaceList())?.some((w) => w.id === id)) {
        await mgr.addWorkspaceWithId(id, entry.name, entry.icon || defaultIcon(), entry.emoji || undefined);
        if (!entry.emoji && Number.isInteger(entry.iconId)) await mgr.setIcon(id, entry.iconId);
        if (!(await until(async () => (await spaceList())?.some((w) => w.id === id), 3000))) throw new Error("Vivaldi did not list the space again");
      }
      // 2. its place, rules and theme (each on its own: one that fails does not keep the tabs from coming back)
      try { const order = orderAfter(((await spaceList()) || []).map((w) => w.id), entry); if (order) await mgr.setOrder(order); }
      catch (error) { console.warn("[vivarc] undelete: its place:", error); }
      const router = routes();
      const have = ((await readPref("vivaldi.workspaces.link_routes")) || []).filter((r) => r?.workspaceId === id);
      for (const r of entry.rules || []) {
        if (have.some((x) => x.type === r.type && x.expression === r.expression)) continue; // an earlier, unfinished undelete put it back
        await Promise.resolve(router?.addLinkRoutingRule(r.type, r.expression, id)).catch((error) => console.warn("[vivarc] undelete: a rule:", error));
      }
      if (entry.theme && (await store().get(THEME_KEY(id), null)) == null) await store().set(THEME_KEY(id), entry.theme);
      // 3. its tabs. Those already back with the id (Vivaldi's own Reopen Closed Tab, an earlier unfinished undelete) are
      // used as they are, never opened twice.
      const all = await chrome.tabs.query({ windowType: "normal" });
      const windows = (await chrome.windows.getAll()).filter((w) => w.type === "normal").map((w) => w.id);
      const plan = restorePlan({ entry, windows, here, live: all.filter((t) => ws().of(t) === id), sameRun: entry.run === runId(),
        sessions: await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []) });
      const target = plan.window;
      const made = [];
      const splits = new Map();
      // Into the space, in the target window. A tab Vivaldi restored elsewhere (with the old window gone it restores a
      // folder's tabs into a new window of their own, measured, p3) is first taken out of the space there: 8.3 refuses to
      // move a tab into a space that also has tabs in another window ("ambiguous windowId").
      // A tab Vivaldi put on screen there (a restore activates it; after a restart it lands in the last focused window)
      // leaves only once that window's own most recent tab is back on screen (a tab on screen cannot leave, G4).
      // Out of the space where it is, in its own window (its default space), with that window's own tab put on screen first
      // if it was on screen there.
      const outOfSpace = async (tab) => {
        if (tab.active) {
          const own = native.record()?.activeIn(tab.windowId) ?? 0;
          const others = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => t.id !== tab.id && ws().of(t) !== id);
          const keeper = ws().recentTab(others.filter((t) => ws().of(t) === own), own) ?? ws().recentTab(others.map((t) => ({ ...t, vivExtData: "{}" })), 0);
          if (keeper) await chrome.tabs.update(keeper.id, { active: true });
        }
        await native.setSpace(tab.id, 0, { windowId: tab.windowId });
      };
      const into = async (tab) => {
        if (tab.windowId !== target && ws().of(tab) === id) await outOfSpace(await chrome.tabs.get(tab.id));
        const now = await chrome.tabs.get(tab.id);
        if (ws().of(now) !== id || now.windowId !== target) await native.setSpace(tab.id, id, { windowId: target });
      };
      // Before any tab goes in: every tab of the space already back in ANOTHER window leaves it there first, so the space
      // never has tabs in two windows when one is moved into it (8.3 refuses that: "ambiguous windowId"; review 9c,
      // important 2: after a restart a reopened tab of the space can sit in another window than the one asking).
      for (const t of plan.tabs.filter((x) => x.how === "live")) {
        const tab = await chrome.tabs.get(t.tab).catch(() => null);
        if (tab && tab.windowId !== target && ws().of(tab) === id) {
          await outOfSpace(tab).catch((error) => console.warn("[vivarc] undelete: a tab of the space in another window:", error));
        }
      }
      // the windows a Recently Closed restore makes (Vivaldi restores a folder's tabs into a new window when their own is
      // gone): only those may be closed afterwards, never a window the user opened meanwhile
      const restoreMade = new Set();
      const normalIds = async () => (await chrome.windows.getAll().catch(() => [])).filter((w) => w.type === "normal").map((w) => w.id);
      for (const t of plan.tabs) {
        renew();
        let tab = null;
        if (t.how === "live") tab = await chrome.tabs.get(t.tab).catch(() => null);
        if (t.how === "session") {
          const before = new Set(await normalIds());
          try { tab = (await chrome.sessions.restore(t.sessionId))?.tab ?? null; } catch (_) { tab = null; }
          for (const w of await normalIds()) if (!before.has(w)) restoreMade.add(w);
          if (tab) tab = await chrome.tabs.get(tab.id).catch(() => null);
        }
        const fresh = !tab;
        if (fresh) tab = await chrome.tabs.create({ windowId: target, url: t.url, active: false, pinned: !!t.pinned }).catch(() => null);
        if (!tab) continue;
        try { await into(tab); } catch (error) { console.warn("[vivarc] undelete: a tab did not go back into its space:", error); }
        // what the tab was: a new tab gets it all; a restored one keeps what Vivaldi brought back and gets what it lacks
        const has = fresh ? {} : extOf(tab);
        const patch = {};
        if (t.vivarcPin && !has.vivarcPin) patch.vivarcPin = t.vivarcPin;
        if (t.tiling?.id && fresh) { if (!splits.has(t.tiling.id)) splits.set(t.tiling.id, crypto.randomUUID?.() || `vm-${Date.now()}-${splits.size}`); patch.tiling = { ...t.tiling, id: splits.get(t.tiling.id) }; }
        if (Object.keys(patch).length) await window.__vm.setExtData(tab, patch).catch(() => {});
        if (t.muted && !tab.mutedInfo?.muted) await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
        if (t.pinned && !fresh && !(await chrome.tabs.get(tab.id).catch(() => tab)).pinned) await chrome.tabs.update(tab.id, { pinned: true }).catch(() => {});
        made.push({ id: tab.id, pinned: !!t.pinned, group: t.group || null, title: t.fixedGroupTitle || null });
      }
      renew();
      const modern = await native.movesByTab();
      // the order: read in the window, the space's tabs must come as they were. Else, on 8.3, each goes just before the
      // next one, from the end (one tab per move: a move of several does not reorder them, measured, p2); on 8.2 by index.
      const loose = made.filter((m) => !m.pinned);
      const now = (await chrome.tabs.query({ windowId: target })).sort((a, b) => a.index - b.index);
      const inWindow = now.filter((t) => loose.some((m) => m.id === t.id)).map((t) => t.id);
      const want = loose.map((m) => m.id).filter((x) => inWindow.includes(x));
      if (!inOrder(inWindow, want)) {
        try {
          if (modern) {
            for (let i = want.length - 2; i >= 0; i--) {
              await vivaldi.tabsPrivate.move({ tabIds: [want[i]], target: want[i + 1], windowId: target, tweaks: ["do-not-reparent"], workspaceId: id, debug: "Vivarc.undelete" });
            }
          } else {
            const base = Math.min(...now.filter((t) => want.includes(t.id)).map((t) => t.index));
            for (let i = 0; i < want.length; i++) await chrome.tabs.move(want[i], { windowId: target, index: base + i });
          }
        } catch (error) { console.warn("[vivarc] undelete: the order:", error); }
      }
      // a window the restore made that is left with nothing but blank tabs closes again
      for (const w of await chrome.windows.getAll({ populate: true }).catch(() => [])) {
        if (restoreMade.has(w.id) && (w.tabs || []).every((t) => ws().isBlank(t))) await chrome.windows.remove(w.id).catch(() => {});
      }
      // 4. shown, the entry gone. A window Vivaldi still records on the space (after a restart it seeds a window's record
      // from its tab on screen, which can be one of the space's, held under its id) is switched to its default space
      // first, as a pull frees a space: else the switch here only focuses that window (A2; seen in fix round 1).
      const recordedIn = native.record()?.all()?.get(id);
      if (recordedIn != null && recordedIn !== target) await native.switchTo(recordedIn, 0).catch((error) => console.warn("[vivarc] undelete: free the space:", error));
      await native.switchTo(target, id).catch((error) => console.warn("[vivarc] undelete: show the space:", error));
      if (target !== here) await native.focus(target).catch(() => {});
      // 5. folders, once the space is shown (Vivaldi's first switch into it undid a folder made before, measured, p3).
      // Vivaldi 8.3 drops a `group` written into a tab's data (p1), so a folder whose tabs came back without it is made
      // again with Vivaldi's own move, as the sidebar makes one, and given its name.
      // A restored tab first carries its old group id. Vivaldi drops it a moment later, and a folder made before its clean-up
      // is undone with it (measured, p3: the same move made 1.5 s later stays). So each folder is made, looked at 1 s
      // later, and made again if it is gone, at most 3 times. A folder that came back under a NEW id is left as it is.
      const groupsNow = async () => new Map((await chrome.tabs.query({ windowId: target })).map((t) => [t.id, extOf(t).group || null]));
      for (const group of new Set(made.filter((m) => m.group).map((m) => m.group))) {
        let current = await groupsNow();
        const members = made.filter((m) => m.group === group && current.has(m.id)).map((m) => m.id);
        if (members.length < 2) continue;
        const one = (map) => { const ids = new Set(members.map((x) => map.get(x))); return ids.size === 1 && !ids.has(null) && !ids.has(group); };
        for (let attempt = 0; attempt < 3 && !one(current); attempt++) {
          renew();
          try {
            // with the space and window named: a move without them files the tabs in the space the window shows (seen,
            // fix round 1: after a restart, before the switch had taken)
            const r = await vivaldi.tabsPrivate.move({ tabIds: members, target: members[0], windowId: target, workspaceId: id, debug: "Vivarc.undelete",
              tweaks: modern ? ["do-not-reparent", "create-new-group"] : ["do-not-reparent", "create-new-group", "target-is-tab"] });
            const title = made.find((m) => m.group === group)?.title;
            if (r?.group && title) await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: r.group, groupTitle: title });
          } catch (error) { console.warn("[vivarc] undelete: a folder:", error); break; }
          await sleep(1000);
          current = await groupsNow();
        }
        if (!one(current)) console.warn(`[vivarc] undelete: the folder of tabs ${members.join(", ")} did not come back`);
      }
      // shown at the end: the switch above did not hold in one path (fix round 1, after a restart with tabs of the space
      // gathered from another window: the window was left recorded on default, showing a tab of the space)
      if (native.record()?.activeIn(target) !== id) await native.switchTo(target, id).catch((error) => console.warn("[vivarc] undelete: show the space again:", error));
      await forget(entry).catch((error) => console.warn("[vivarc] undelete: forget the entry:", error));
      return { window: target, space: id, tabs: made.length };
    } finally { restoring().delete(id); end?.(); }
  };

  // ---- editing (the space tile's right-click menu, and +) ----
  // Renames space `id`: its Pinned folder FIRST, so its pins stay with it (upstream #126), then the space. While that
  // runs, no window makes the space an empty folder for a name that does not match yet (10-sidebar.js applySpace asks
  // renaming()). folder: its bookmark folder or null.
  const RENAME_MARK = "__vivarcSpaceRename";
  const renaming = (id) => { const m = page()[RENAME_MARK]; return !!m && m.until > Date.now() && (id == null || m.id === id); };
  const rename = async (id, name, folder) => {
    normalOnly();
    const mgr = manager();
    if (!mgr) throw new Error("Vivaldi's workspace manager was not found");
    const mark = { id, until: Date.now() + 8000 };
    page()[RENAME_MARK] = mark;
    let renamed = false;
    try {
      if (folder) { await chrome.bookmarks.update(folder.id, { title: folderTitle(folder.title, name) }); renamed = true; }
      await mgr.setName(id, name);
      if (!(await until(async () => (await spaceList())?.find((w) => w.id === id)?.name === name, 3000))) throw new Error("Vivaldi did not take the new name");
    } catch (error) {
      // the folder goes back to its name, so the space and its pins stay together
      if (renamed) {
        await chrome.bookmarks.update(folder.id, { title: folder.title }).catch((undo) =>
          console.warn(`[vivarc] rename: the Pinned folder keeps the name "${folderTitle(folder.title, name)}"; its pins stay with it, but the space is still "${folder.title}":`, undo));
      }
      throw error;
    } finally {
      // kept a moment longer: a window's refresh that read the old name before the change may still be running
      mark.until = Date.now() + 1500;
      setTimeout(() => { if (page()[RENAME_MARK] === mark) delete page()[RENAME_MARK]; }, 1500);
    }
  };
  const setOrder = async (ids) => { normalOnly(); const mgr = manager(); if (!mgr) throw new Error("Vivaldi's workspace manager was not found"); await mgr.setOrder(ids); };
  const setIcon = async (id, index) => { normalOnly(); const mgr = manager(); if (!mgr) throw new Error("Vivaldi's workspace manager was not found"); await mgr.setIcon(id, index); };
  const setEmoji = async (id, emoji) => { normalOnly(); const mgr = manager(); if (!mgr) throw new Error("Vivaldi's workspace manager was not found"); await mgr.setEmoji(id, emoji || undefined); };
  // A new space at once, named and with Vivaldi's default icon, not shown (the empty space would open the command bar
  // over its rename). -> its id.
  const create = async (name) => {
    normalOnly();
    const mgr = manager();
    if (!mgr) throw new Error("Vivaldi's workspace manager was not found");
    const id = await mgr.addWorkspace(name, defaultIcon(), undefined, null, true);
    if (!(await until(async () => (await spaceList())?.some((w) => w.id === id), 3000))) throw new Error("Vivaldi did not list the new space");
    return id;
  };

  window.__vm.spaceEdit = {
    DELETED_KEY, KEEP_MS, KEEP_MAX, PRIVATE, isPrivate, deletedEntry, keepDeleted, held, sameDeleted, matchSessions, orderAfter, restorePlan, inOrder, deletedNote,
    moved, newSpaceName, renameCheck, folderTitle, findManager, findRoutes, findIcons,
    manager, icons, list, remember, noteClosed, undelete, forget, rename, renaming, setOrder, setIcon, setEmoji, create,
  };
})();
