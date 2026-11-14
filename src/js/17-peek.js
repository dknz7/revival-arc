// Vivarc and Peek (the optional community link preview, VividPeek.js, sha-pinned and never edited: vivarc.py only sets
// its triggers). Peek's instance appears as window.ArcPeekDebug, assigned in its constructor; Peek's file is bundled
// after this one, so a property set here catches that assignment and wraps two of Peek's methods at runtime. Without
// Peek (or a Peek whose methods or records are not as expected) everything here falls back to doing nothing: the lists
// then show every tab (filters fail open) and nothing is closed (closing fails closed).
// On Vivaldi 8.3 (task 8y, B1; upstream KASOGIT/vivarc#165/#166, commit 4d95950):
// - Peek preloads the previewed page in a tab it "stashes" in another space, written into vivExtData, which 8.3
//   drops: the tab lands in the default space. "Open in New Tab" and "Open in Background" then bring it back by writing
//   workspaceId again (dropped again), so the tab stayed in the default space; activated there, repair 2 snapped the
//   window back and the page vanished. Its move-back is wrapped: the tab goes first into the space on screen, beside its
//   source, through native.setSpace (the one way Vivarc sets a space), and Peek's own steps then find it there.
// - When "Open in New Tab" has used the preloaded tab, Peek leaves its other tab (the one backing the preview,
//   vivExtData.arcPeekRuntime) open for good (it disposes with closeRuntimeTab: !usedParallel). That copy is closed,
//   only after a promotion this wrap saw, and only if it is that preview's own, not adopted, runtime tab.
// - Both tabs are kept out of Vivarc's lists while a preview is open, in every window: each window's live preview tab
//   ids are kept on the background page (LIVE_KEY), and a preview made into a tab leaves that registry at once.
// - Recently Closed leaves out the entries of preview tabs Peek closed, matched one by one to the closing tab (address
//   and time, one candidate only: claimClosed). A tab the user closed is never hidden.
(() => {
  const spacesOf = window.__vm.workspaces;
  const LIVE_KEY = "__vivarcPeekLive"; // background page: { [window copy token]: [tab ids] }
  const CLAIMED_KEY = "__vivarcPeekClosed"; // background page: [sessionId], the newest last
  const CLAIMED_MAX = 100;
  const CLAIM_DELAY_MS = 400; // Chromium lists a closed tab in the session service just after onRemoved
  const token = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const shared = () => { try { return chrome.extension?.getBackgroundPage?.() || null; } catch (_) { return null; } };
  const warnedOf = new Set();
  const warn = (what, error) => { if (warnedOf.has(what)) return; warnedOf.add(what); console.warn(`[vivarc] peek: ${what}:`, error); };

  let instance = null;
  const promoted = new Set(); // preloaded tabs made into the user's tabs (Peek's record may still name them for a moment)
  const promotedFor = new Set(); // the previews (webview ids) this wrap brought into the space on screen
  const previews = () => {
    try { const w = instance?.webviews; return w && typeof w.values === "function" ? [...w.values()] : []; } catch (_) { return []; }
  };
  const preview = (webviewId) => {
    try { const w = instance?.webviews; return w && typeof w.get === "function" ? w.get(webviewId) ?? null : null; } catch (_) { return null; }
  };
  const own = () => { const set = spacesOf.peekIds(previews()); for (const id of promoted) set.delete(id); return set; };
  // This window's live preview tabs, onto the shared page so every window's lists see them. Tab events come by the
  // thousand while a window loads many tabs: without Peek nothing is done, and the shared page is written only when
  // this window's set changed.
  let published = "";
  const publish = () => {
    if (!instance && !published) return;
    try {
      const ids = [...own()].sort((a, b) => a - b);
      const key = ids.join(",");
      if (key === published) return;
      const page = shared();
      if (!page) return;
      const reg = page[LIVE_KEY] && typeof page[LIVE_KEY] === "object" ? page[LIVE_KEY] : (page[LIVE_KEY] = {});
      if (ids.length) reg[token] = ids; else delete reg[token];
      published = key;
    } catch (_) {}
  };
  const ids = () => {
    const set = instance ? own() : new Set();
    try {
      for (const list of Object.values(shared()?.[LIVE_KEY] || {})) for (const id of Array.isArray(list) ? list : []) if (Number.isInteger(id)) set.add(id);
    } catch (_) {}
    for (const id of promoted) set.delete(id);
    return set;
  };
  const isPeekTab = (tab) => spacesOf.isPeekTab(tab, ids());
  const api = {
    isPeekTab,
    without: (tabs) => { try { const open = ids(); return (tabs || []).filter((t) => !spacesOf.isPeekTab(t, open)); } catch (_) { return tabs || []; } },
    withoutClosed: (sessions) => { try { return spacesOf.withoutPeekClosed(sessions, shared()?.[CLAIMED_KEY] || []); } catch (_) { return sessions || []; } },
  };
  window.__vm.peek = api;

  // This window's preview tabs while they live (a closed tab's address is gone), so the session entry each one leaves
  // can be claimed when it closes.
  const seen = new Map(); // tab id -> address
  const note = (tab) => { if (instance && tab?.id != null && !promoted.has(tab.id) && own().has(tab.id)) seen.set(tab.id, tab.pendingUrl || tab.url || ""); };
  // Closes of one address are claimed together (Peek closes both of a preview's tabs at once): claimClosed takes them
  // only if exactly that many entries match, so a tab of the user's closed in the same moment keeps every entry shown.
  const pending = new Map(); // address -> { n, at, timer }
  // Chromium can list a closed tab a moment after onRemoved (later under load): while fewer entries than closed preview
  // tabs are listed, it looks again, up to 4 times over about 2 s. More entries than that: a user's tab may be among
  // them, and nothing is claimed.
  const CLAIM_TRIES = 4, CLAIM_RETRY_MS = 600;
  const claim = async (url, p, tries = 1) => {
    if (tries === 1) pending.delete(url);
    try {
      const page = shared();
      if (!page) return;
      const taken = Array.isArray(page[CLAIMED_KEY]) ? page[CLAIMED_KEY] : [];
      const closed = { url, at: p.at, n: p.n };
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      const sids = spacesOf.claimClosed(closed, sessions, taken);
      if (sids.length) page[CLAIMED_KEY] = [...taken, ...sids].slice(-CLAIMED_MAX);
      else if (tries < CLAIM_TRIES && spacesOf.claimLater(closed, sessions, taken)) setTimeout(() => claim(url, p, tries + 1), CLAIM_RETRY_MS);
    } catch (error) { warn("match a closed preview tab", error); }
  };
  const closed = (id) => {
    if (!seen.has(id)) return;
    const url = seen.get(id);
    seen.delete(id);
    if (!url) return;
    const p = pending.get(url) || { n: 0, at: 0, timer: 0 };
    p.n += 1;
    p.at = Date.now();
    clearTimeout(p.timer);
    p.timer = setTimeout(() => claim(url, p), CLAIM_DELAY_MS);
    pending.set(url, p);
  };
  const changed = () => { publish(); window.dispatchEvent(new CustomEvent("vm-peek-changed")); };

  // The preloaded tab, into the space on screen in this window, just after the tab the link was in. -> true when moved.
  const bringBack = async (data) => {
    const id = data?.parallelTabId;
    const native = window.__vm.native;
    if (!Number.isInteger(id) || typeof native?.setSpace !== "function") return false;
    const here = (await chrome.windows.getCurrent()).id;
    const inWindow = await chrome.tabs.query({ windowId: here });
    const shown = native.record()?.activeIn(here) ?? spacesOf.activeId(inWindow);
    if (!(await chrome.tabs.get(id).catch(() => null))) return false;
    const others = inWindow.filter((t) => t.id !== id).sort((a, b) => a.index - b.index);
    await native.setSpace(id, shown, { windowId: here, index: spacesOf.besideSource(others, data.tabId) });
    return true;
  };

  const attach = (peek) => {
    const moveBack = peek._moveParallelTabToMainWindow;
    if (typeof moveBack === "function") {
      // Peek calls this only to make a preview into a tab (Open in New Tab, Open in Background): its preloaded tab is the
      // user's from here on, in every window's lists.
      peek._moveParallelTabToMainWindow = async function (webviewId) {
        const data = preview(webviewId);
        const id = data?.parallelTabId;
        try { if (await bringBack(data)) promotedFor.add(webviewId); } catch (error) { warn("bring the preview's tab into the space on screen", error); }
        if (Number.isInteger(id)) { promoted.add(id); seen.delete(id); changed(); }
        return moveBack.call(this, webviewId);
      };
    }
    const dispose = peek.disposePeek;
    if (typeof dispose === "function") {
      peek.disposePeek = async function (webviewId, options = {}) {
        const data = preview(webviewId);
        const runtime = Number.isInteger(data?.relatedTabId) ? data.relatedTabId : null;
        // what is about to close: noted with its address now, for Recently Closed
        for (const id of [data?.parallelTabId, runtime]) if (Number.isInteger(id)) note(await chrome.tabs.get(id).catch(() => null));
        const result = await dispose.call(this, webviewId, options);
        try {
          if (options?.closeRuntimeTab === false && runtime != null && promotedFor.has(webviewId)) {
            const tab = await chrome.tabs.get(runtime).catch(() => null);
            let ext = {};
            try { ext = JSON.parse(tab?.vivExtData || "{}") || {}; } catch (_) { ext = null; }
            if (tab && ext?.arcPeekRuntime?.webviewId === webviewId && !ext.arcPeekAdopted) {
              seen.set(tab.id, tab.pendingUrl || tab.url || "");
              await chrome.tabs.remove(runtime);
            }
          }
        } catch (error) { warn("close the preview's leftover tab", error); }
        promotedFor.delete(webviewId);
        const still = spacesOf.peekIds(previews());
        for (const id of [...promoted]) if (!still.has(id)) promoted.delete(id);
        changed();
        return result;
      };
    }
  };

  try {
    Object.defineProperty(window, "ArcPeekDebug", {
      configurable: true,
      get: () => instance,
      set: (peek) => {
        const first = !instance;
        instance = peek;
        if (first && peek && typeof peek === "object") { try { attach(peek); } catch (error) { warn("attach", error); } }
      },
    });
  } catch (error) { warn("watch for Peek", error); }

  try {
    chrome.tabs.onCreated.addListener((tab) => { note(tab); publish(); });
    chrome.tabs.onUpdated.addListener((_id, _change, tab) => { note(tab); publish(); });
    chrome.tabs.onRemoved.addListener((id) => { closed(id); publish(); });
  } catch (_) {}
  window.addEventListener("beforeunload", () => { try { delete shared()?.[LIVE_KEY]?.[token]; } catch (_) {} });
})();
