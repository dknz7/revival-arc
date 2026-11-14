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
// - Recently Closed leaves out only entries whose closed tab carries Peek's identity in its own data: Peek's runtime tab
//   (arcPeekRuntime), or a preloaded tab this file marked as a preview (PEEK_MARK, cleared before a promotion). An entry
//   without that identity is shown: a tab the user closed is never hidden (Task 9a fix round 2).
(() => {
  const spacesOf = window.__vm.workspaces;
  const LIVE_KEY = "__vivarcPeekLive"; // background page: { [window copy token]: [tab ids] }
  // A preview mark that could not be cleared from a tab Peek made the user's: from then on a mark proves nothing, so
  // Recently Closed hides only Peek's own runtime tabs (fail open). Kept on the background page and in Vivarc's store, so
  // a restart (which keeps the stuck mark on the tab) keeps it too.
  const STUCK_KEY = "__vivarcPeekMarkStuck", STUCK_STORE = "peekMarkStuck";
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
    withoutClosed: (sessions) => { try { return spacesOf.withoutPeekClosed(sessions, { marks: !shared()?.[STUCK_KEY] }); } catch (_) { return sessions || []; } },
  };
  window.__vm.peek = api;

  // Peek's preloaded tab carries no mark of its own: this window marks each one of its live previews in the tab's data
  // (vivExtData merges, so only that key is written), so its Recently Closed entry is known to be Peek's. A promotion
  // clears the mark first (see attach); a mark that could not be written leaves the entry shown.
  const marked = new Set();
  const mark = (tab) => {
    if (!instance || tab?.id == null || marked.has(tab.id) || promoted.has(tab.id)) return;
    const data = previews().find((d) => d?.parallelTabId === tab.id);
    if (!data) return;
    marked.add(tab.id);
    chrome.tabs.update(tab.id, { vivExtData: JSON.stringify({ [spacesOf.PEEK_MARK]: true }) }).catch((error) => { marked.delete(tab.id); warn("mark a preview tab", error); });
  };
  // Cleared and checked: up to 3 tries, each read back. -> true when the tab no longer carries the mark (or is gone).
  // Otherwise marks stop counting anywhere (STUCK_KEY), so this user's tab is never hidden from Recently Closed.
  const unmark = async (id) => {
    marked.delete(id);
    for (let tries = 0; tries < 3; tries++) {
      if (tries) await new Promise((resolve) => setTimeout(resolve, 150 * tries));
      try { await chrome.tabs.update(id, { vivExtData: JSON.stringify({ [spacesOf.PEEK_MARK]: null }) }); } catch (_) {}
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) return true;
      let ext = null;
      try { ext = JSON.parse(tab.vivExtData || "{}") || {}; } catch (_) {}
      if (ext && !(spacesOf.PEEK_MARK in ext)) return true;
    }
    try { const page = shared(); if (page) page[STUCK_KEY] = true; } catch (_) {}
    Promise.resolve(window.__vm.store?.set?.(STUCK_STORE, true)).catch(() => {});
    warn("clear a preview tab's mark", new Error(`tab ${id} kept it: marks no longer hide Recently Closed entries`));
    return false;
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
        if (Number.isInteger(id)) {
          promoted.add(id);
          await unmark(id).catch((error) => warn("clear a preview tab's mark", error)); // the user's tab from here on
          changed();
        }
        try { if (await bringBack(data)) promotedFor.add(webviewId); } catch (error) { warn("bring the preview's tab into the space on screen", error); }
        return moveBack.call(this, webviewId);
      };
    }
    const dispose = peek.disposePeek;
    if (typeof dispose === "function") {
      peek.disposePeek = async function (webviewId, options = {}) {
        const data = preview(webviewId);
        const runtime = Number.isInteger(data?.relatedTabId) ? data.relatedTabId : null;
        const result = await dispose.call(this, webviewId, options);
        try {
          if (options?.closeRuntimeTab === false && runtime != null && promotedFor.has(webviewId)) {
            const tab = await chrome.tabs.get(runtime).catch(() => null);
            let ext = {};
            try { ext = JSON.parse(tab?.vivExtData || "{}") || {}; } catch (_) { ext = null; }
            if (tab && ext?.arcPeekRuntime?.webviewId === webviewId && !ext.arcPeekAdopted) await chrome.tabs.remove(runtime);
          }
        } catch (error) { warn("close the preview's leftover tab", error); }
        promotedFor.delete(webviewId);
        const still = spacesOf.peekIds(previews());
        for (const id of [...promoted]) if (!still.has(id)) promoted.delete(id);
        for (const id of [...marked]) if (!still.has(id)) marked.delete(id);
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
    chrome.tabs.onCreated.addListener((tab) => { mark(tab); publish(); });
    chrome.tabs.onUpdated.addListener((_id, _change, tab) => { mark(tab); publish(); });
    chrome.tabs.onRemoved.addListener(() => publish());
  } catch (_) {}
  window.addEventListener("beforeunload", () => { try { delete shared()?.[LIVE_KEY]?.[token]; } catch (_) {} });
  Promise.resolve(window.__vm.store?.get?.(STUCK_STORE, false)).then((stuck) => { if (stuck) { const page = shared(); if (page) page[STUCK_KEY] = true; } }, () => {});
})();
