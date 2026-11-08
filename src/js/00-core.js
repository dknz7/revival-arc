// Vivarc core: config, the "vm-on" marker class (all CSS is scoped to it), a small IndexedDB store,
// and a hook on Vivaldi's keyboard-shortcut event, shared by the other modules through window.__vm.
(() => {
  const defaults = {
    hideWorkspaceButton: true,
    compactBottomBar: true,
    suggestions: "default",
    spaceFolderTitle: "Vivarc",
  };
  const config = { ...defaults, ...(window.__vmConfig || {}) };

  const windows = config.platform === "Windows";
  const shortcut = (combo) => {
    if (combo === "alt+meta+left" || combo === "alt+meta+right") {
      return windows ? combo.replace("alt+meta", "ctrl") : combo;
    }
    if (!windows) return combo;
    if (combo === "ctrl+meta+n") return "alt+ctrl+n";
    return combo.replace("ctrl+meta+", "ctrl+shift+").replace("meta", "ctrl");
  };
  const subscribers = new Set();
  const dbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open("vivarc", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const store = {
    get: (key, fallback) => dbReady.then((db) => new Promise((resolve) => {
      const q = db.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => resolve(q.result ?? fallback);
      q.onerror = () => resolve(fallback);
    })).catch(() => fallback),
    // Like get, but a failed read REJECTS instead of resolving the fallback (a missing key resolves undefined). For callers
    // that write back what they read: a failed read must not look like an empty value.
    read: (key) => dbReady.then((db) => new Promise((resolve, reject) => {
      const q = db.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error || new Error("read failed"));
    })),
    set: (key, value) => dbReady.then((db) => new Promise((resolve) => {
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    })).catch(() => {}),
  };

  const normalise = (combo) => String(combo).toLowerCase().split("+").map((s) => s.trim()).sort().join("+");
  let last = { key: "", at: 0 };
  const handler = (...args) => {
    const combo = args.find((a) => typeof a === "string");
    if (!combo) return;
    const key = normalise(combo);
    const now = Date.now();
    if (key === last.key && now - last.at < 250) return;
    last = { key, at: now };
    // Every window's listener hears every key; the number in the event is the Vivaldi window the key was pressed in
    // (measured on 8.2: it equals window.vivaldiWindowId there), handed on for the modules that act on one window only.
    const pressedIn = args.find((a) => typeof a === "number");
    subscribers.forEach((fn) => fn(key, combo, pressedIn));
  };
  try {
    vivaldi.tabsPrivate.onKeyboardShortcut.addListener(handler);
  } catch (e) {
    console.warn("[vivarc] shortcut hook unavailable:", e);
  }

  // Vivaldi keeps a tab's tile ("split view") membership in its vivExtData JSON: {tiling: {id, layout, type, index}}.
  const tilingOf = (tab) => {
    try { return JSON.parse(tab?.vivExtData || "{}").tiling; } catch (_) { return undefined; }
  };

  // Merge `patch` into a tab's vivExtData. chrome.tabs.update MERGES vivExtData, so a key only leaves when it is written
  // as null (measured on 8.2: left out, undefined and "" all keep it).
  const setExtData = async (tab, patch) => {
    const fresh = await chrome.tabs.get(tab.id);
    let ext = {};
    try { ext = JSON.parse(fresh.vivExtData || "{}"); } catch (_) {}
    await chrome.tabs.update(tab.id, { vivExtData: JSON.stringify({ ...ext, ...patch }) });
  };
  // Break a split view: every tab of the tab's window in the same tile group loses its tiling.
  const unsplit = async (tab) => {
    const id = tilingOf(tab)?.id;
    if (!id) return;
    const peers = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => tilingOf(t)?.id === id);
    await Promise.all(peers.map((t) => setExtData(t, { tiling: null })));
  };

  window.__vm = { config, store, shortcut, windows, normalise, tilingOf, setExtData, unsplit, onShortcut: (fn) => subscribers.add(fn) };

  // Vivaldi re-renders #browser's class list, so the marker classes are re-applied whenever they go missing.
  const markListeners = new Set();
  let watched = null;
  const mark = () => {
    const browser = document.querySelector("#browser");
    if (!browser) return false;
    browser.classList.add("vm-on");
    browser.classList.toggle("vm-hide-workspaces", !!config.hideWorkspaceButton);
    markListeners.forEach((fn) => fn(browser));
    if (watched !== browser) {
      watched = browser;
      new MutationObserver(() => { if (!browser.classList.contains("vm-on")) mark(); })
        .observe(browser, { attributes: true, attributeFilter: ["class"] });
    }
    return true;
  };
  window.__vm.onMark = (fn) => { markListeners.add(fn); if (watched) fn(watched); };
  if (!mark()) {
    const observer = new MutationObserver(() => { if (mark()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  // The UI modules stay dormant unless the stylesheet is loaded too (e.g. a profile not set up yet).
  let cssResolve;
  window.__vm.cssLoaded = false;
  window.__vm.ready = new Promise((resolve) => { cssResolve = resolve; });
  const checkCss = (tries = 0) => {
    const browser = document.querySelector("#browser");
    if (browser && getComputedStyle(browser).getPropertyValue("--vm-css").trim() === "1") {
      window.__vm.cssLoaded = true;
      cssResolve(true);
    } else if (tries < 20) {
      setTimeout(() => checkCss(tries + 1), 250);
    } else {
      cssResolve(false);
    }
  };
  checkCss();
  console.log("[vivarc] core started");
})();
