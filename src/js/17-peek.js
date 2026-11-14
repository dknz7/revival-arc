// Vivarc and Peek (the optional community link preview, VividPeek.js, sha-pinned and never edited: vivarc.py only sets
// its triggers). Peek's instance appears as window.ArcPeekDebug, assigned in its constructor; Peek's file is bundled
// after this one, so a property set here catches that assignment and wraps two of Peek's methods at runtime. Without
// Peek (or a Peek whose methods are not there) everything here falls back to doing nothing.
// On Vivaldi 8.3 (task 8y, B1; upstream KASOGIT/vivarc#165/#166, commit 4d95950):
// - Peek preloads the previewed page in a tab it "stashes" in another space, written into vivExtData, which 8.3
//   drops: the tab lands in the default space. "Open in New Tab" and "Open in Background" then bring it back by writing
//   workspaceId again (dropped again), so the tab stayed in the default space; activated there, repair 2 snapped the
//   window back and the page vanished. Its move-back is wrapped: the tab goes first into the space on screen, beside its
//   source, through native.setSpace (the one way Vivarc sets a space), and Peek's own steps then find it there.
// - When "Open in New Tab" uses the preloaded tab, Peek leaves its other tab (the one backing the preview,
//   vivExtData.arcPeekRuntime) open for good (it disposes with closeRuntimeTab: !usedParallel). That copy is closed.
// - Both tabs are kept out of Vivarc's lists while a preview is open (workspaces.isPeekTab), and the ones Peek closes
//   out of the New Tab dropdown's Recently Closed (workspaces.withoutPeekClosed).
(() => {
  const spacesOf = window.__vm.workspaces;
  const CLOSED_KEY = "__vivarcPeekClosed"; // on the background page, shared by every window: [{ url, at }]
  const CLOSED_MAX = 50;
  const shared = () => { try { return chrome.extension?.getBackgroundPage?.() || null; } catch (_) { return null; } };
  let warned = false;
  const warn = (what, error) => { if (warned) return; warned = true; console.warn(`[vivarc] peek: ${what}:`, error); };

  let instance = null;
  const ids = () => spacesOf.peekIds(instance?.webviews?.values?.() || []);
  const isPeekTab = (tab) => spacesOf.isPeekTab(tab, ids());
  const api = {
    isPeekTab,
    without: (tabs) => { const open = ids(); return (tabs || []).filter((t) => !spacesOf.isPeekTab(t, open)); },
    withoutClosed: (sessions) => spacesOf.withoutPeekClosed(sessions, shared()?.[CLOSED_KEY] || []),
  };
  window.__vm.peek = api;

  // What Peek's tabs are, by id, while they live (a tab's address is gone once it is closed), and when they close.
  const seen = new Map();
  let creating = false; // Peek raises this flag around the creation of its tabs, whose ids it learns only afterwards
  const note = (tab) => { if (tab?.id != null && (creating || isPeekTab(tab))) seen.set(tab.id, tab.pendingUrl || tab.url || ""); };
  const closed = (id) => {
    if (!seen.has(id)) return;
    const url = seen.get(id);
    seen.delete(id);
    const page = shared();
    if (!page || !url) return;
    page[CLOSED_KEY] = [...(page[CLOSED_KEY] || []), { url, at: Date.now() }].slice(-CLOSED_MAX);
  };
  // A tab that stopped being Peek's (a preview made into a real tab) is forgotten, so its own close later is not hidden.
  const forgetUsers = async () => {
    for (const id of [...seen.keys()]) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab && !isPeekTab(tab)) seen.delete(id);
    }
  };

  // The preloaded tab, into the space on screen in this window, just after the tab the link was in.
  const bringBack = async (peek, webviewId) => {
    const data = peek.webviews?.get?.(webviewId);
    const id = data?.parallelTabId;
    const native = window.__vm.native;
    if (id == null || !native?.setSpace) return;
    const here = (await chrome.windows.getCurrent()).id;
    const inWindow = await chrome.tabs.query({ windowId: here });
    const shown = native.record()?.activeIn(here) ?? spacesOf.activeId(inWindow);
    if (!(await chrome.tabs.get(id).catch(() => null))) return;
    const others = inWindow.filter((t) => t.id !== id).sort((a, b) => a.index - b.index);
    await native.setSpace(id, shown, { windowId: here, index: spacesOf.besideSource(others, data.tabId) });
  };

  const attach = (peek) => {
    const moveBack = peek._moveParallelTabToMainWindow;
    if (typeof moveBack === "function") {
      peek._moveParallelTabToMainWindow = async function (webviewId) {
        try { await bringBack(this, webviewId); } catch (error) { warn("bring the preview's tab into the space on screen", error); }
        return moveBack.call(this, webviewId);
      };
    }
    const dispose = peek.disposePeek;
    if (typeof dispose === "function") {
      peek.disposePeek = async function (webviewId, options = {}) {
        const runtime = this.webviews?.get?.(webviewId)?.relatedTabId ?? null;
        const result = await dispose.call(this, webviewId, options);
        if (options?.closeRuntimeTab === false && runtime != null) {
          const tab = await chrome.tabs.get(runtime).catch(() => null);
          if (tab && spacesOf.isPeekTab(tab, new Set())) {
            note(tab);
            await chrome.tabs.remove(runtime).catch((error) => warn("close the preview's leftover tab", error));
          }
        }
        setTimeout(() => { forgetUsers().catch(() => {}); window.dispatchEvent(new CustomEvent("vm-peek-changed")); }, 1000);
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
        if (first && peek) { try { attach(peek); } catch (error) { warn("attach", error); } }
      },
    });
  } catch (error) { warn("watch for Peek", error); }

  window.addEventListener("vmod-suppress-tab-toast", (e) => { creating = !!e.detail?.suppress; });
  try {
    chrome.tabs.onCreated.addListener(note);
    chrome.tabs.onUpdated.addListener((_id, _change, tab) => note(tab));
    chrome.tabs.onRemoved.addListener((id) => closed(id));
  } catch (_) {}
})();
