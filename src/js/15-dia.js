// Vivarc's Dia layout (setting "Dia layout"): a slim row over the page (Vivaldi's menu, back, forward, reload, a
// "site / title" breadcrumb, translate (on a page not in English), copy link, extensions and the window buttons) with
// the sidebar up to the window's top.
// Vivaldi draws that row, and its own window buttons in it, once its address row is on (and, on Windows, its own window
// frame instead of the system's). Turning the layout on keeps the user's values for those prefs; off puts them back.
// The page column's left edge is tracked in --vm-dia-left, so the row follows a resized or hidden (Ctrl+S) sidebar.
(() => {
  const ADDRESS = "vivaldi.address_bar.visible";
  const ROW = "vivaldi.toolbars.navigation";
  const FRAME = "vivaldi.windows.use_native_decoration";
  const ROW_ITEMS = ["Back", "Forward", "Reload", "FlexibleSpacer", "Extensions"];
  // Same blank-tab check as 20-command-bar.js (a test keeps them equal).
  const BLANK = /^(chrome|vivaldi):\/\/(newtab|vivaldi-webui\/startpage)/;
  const SECTION = /[?&]section=(?!Speed-dials(?:[&#]|$))/i;

  // The prefs the layout sets on this platform, in the order they are set. The window frame only exists as a choice on
  // Windows. Vivaldi places its window buttons when the address row's pref changes, so the frame goes first and the
  // address row last, both ways: the other order leaves a window with neither its own buttons nor the system's.
  const target = (windows) => ({ ...(windows ? { [FRAME]: false } : {}), [ROW]: ROW_ITEMS, [ADDRESS]: true });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // For the switch being `on`, the prefs now and the user's values kept earlier (or null): the prefs to set, and the
  // values to keep from now on (null: forget them). A value is kept only while it differs from the layout's, and never
  // overwritten, so a value another window has already changed is never taken for the user's. The address row is not
  // kept: the Arc layout needs it off, so off is what it goes back to.
  const plan = (on, current, saved, windows) => {
    const changes = (want) => Object.fromEntries(Object.entries(want).filter(([path, value]) => !same(current[path], value)));
    if (on) {
      const want = target(windows);
      const kept = { ...(saved || {}) };
      for (const [path, value] of Object.entries(want)) {
        if (path !== ADDRESS && !(path in kept) && !same(current[path], value)) kept[path] = current[path];
      }
      return { set: changes(want), saved: kept };
    }
    // Nothing kept: the layout was not on, and Vivaldi's prefs are not its business.
    if (!saved) return { set: {}, saved: null };
    const back = {}; // frame first and the address row last (see target)
    for (const path of [FRAME, ROW]) if (path in saved) back[path] = saved[path];
    back[ADDRESS] = false;
    return { set: changes(back), saved: null };
  };

  // What the breadcrumb shows for a tab: its site (a web page's host) and its title.
  const crumbOf = (tab) => {
    const url = tab?.pendingUrl || tab?.url || "";
    if (BLANK.test(url) && !SECTION.test(url)) return { site: "", title: "New Tab" };
    let site = "";
    try {
      const parsed = new URL(url);
      if (/^https?:$/.test(parsed.protocol)) site = parsed.hostname.replace(/^www\./, "");
    } catch (_) {}
    return { site, title: tab?.title || url };
  };

  // The page column's distance from the window's left and right edges, measured outside the page card's own margins
  // (the layout's gap, not something beside the page): the row over it reaches the window's corner.
  const columnEdges = (box, marginLeft, marginRight, width) => ({
    left: Math.round(box.left - (parseFloat(marginLeft) || 0)),
    right: Math.round(width - box.right - (parseFloat(marginRight) || 0)),
  });

  // The Translate button for a tab, from Vivaldi's own translation state for it ({pageLanguage, isTranslated,
  // translateStep}, as its address-bar button reads it): null keeps it hidden. Only a web page whose language Chromium
  // has determined, and is not English, gets it; a translated page gets "Show original" instead, whatever its language.
  // "Translating…" stays clickable: a translation asked for while the tab was hidden stays at that step, and a new
  // click is what finishes it.
  const translateOf = (url, state) => {
    if (!/^https?:/i.test(url || "")) return null;
    if (state?.isTranslated) return { revert: true, label: "Show original" };
    const from = state?.pageLanguage || "";
    if (!from || from === "und" || /^en(-|$)/i.test(from)) return null;
    return { revert: false, from, label: state.translateStep === "translating" ? "Translating…" : "Translate" };
  };

  // Vivaldi's translation state per tab lives in its own store, which its address-bar button reads. A mod has no API
  // for it: the store is found in webpack's modules as findRemover (07-workspaces.js) finds Vivaldi's workspace manager.
  const findTranslation = (chunks) => {
    try {
      let load;
      chunks.push([[Symbol("vivarc-translation")], {}, (require) => { load = require; }]);
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes("VIVALDI_TABS_LANGUAGE_DETERMINED")) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const store of Object.values(exported || {})) {
          if (typeof store?.getPageState === "function") return (tabId) => store.getPageState(tabId);
        }
      }
    } catch (_) {}
    return null;
  };

  window.__vm.dia = { target, plan, crumbOf, columnEdges, translateOf, findTranslation, ROW_ITEMS };
  if (!window.__vm.store) return;

  const { store, settings } = window.__vm;
  const windows = !!window.__vm.windows;
  const KEPT = "dia:kept";
  const prefs = {
    get: async (path) => (await vivaldi.prefs.get(path))?.value,
    set: (path, value) => vivaldi.prefs.set({ path, value }),
  };

  // Every window runs this and all of them hear the switch: each step is idempotent, and they queue per window.
  // The user's values are kept before anything changes, and forgotten only once they are back: a restore cut short
  // (a window closed, Vivaldi quit) leaves them for the next window to finish.
  let queue = Promise.resolve();
  const sync = (on) => {
    queue = queue.then(async () => {
      const paths = Object.keys(target(windows));
      const current = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await prefs.get(path)])));
      const saved = await store.get(KEPT, null);
      const next = plan(on, current, saved, windows);
      if (next.saved && !same(next.saved, saved)) await store.set(KEPT, next.saved);
      for (const [path, value] of Object.entries(next.set)) await prefs.set(path, value);
      if (!next.saved && saved) await store.set(KEPT, null);
    }).catch((error) => console.warn("[vivarc] Dia layout:", error));
  };
  // Only a normal window writes the prefs: private, popup and settings windows follow the profile's.
  const writes = async () => {
    const win = await chrome.windows.getCurrent().catch(() => null);
    let kind = "normal";
    try { kind = JSON.parse(win?.vivExtData || "{}").windowType || "normal"; } catch (_) {}
    return !!win && win.type === "normal" && !win.incognito && kind === "normal";
  };

  // ---- breadcrumb ----
  let crumb = null;
  let siteNode = null;
  let titleNode = null;
  let ownWindow = null;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0];
  const toast = (detail) => window.dispatchEvent(new CustomEvent("vm-toast", { detail }));

  // Translate: Vivaldi's own page translation (what its address-bar button does), into English. The store is looked up
  // once, when first needed; without it the button stays hidden.
  let translateNode = null;
  let translation = null;
  let lookedAt = 0;
  let warned = false;
  let asked = null; // the tab a click asked to translate, until Vivaldi says how it went
  const translationOf = (tabId) => {
    if (!translation && Date.now() - lookedAt > 5000) {
      lookedAt = Date.now();
      translation = findTranslation(window.webpackChunkgapp_browser_react) ||
        findTranslation(chrome.extension?.getBackgroundPage?.()?.webpackChunkgapp_browser_react);
      if (!translation && !warned) {
        warned = true;
        console.warn("[vivarc] Dia layout: Vivaldi's translation state not found, no Translate button");
      }
    }
    try { return translation ? translation(tabId) : null; } catch (_) { return null; }
  };
  const showTranslate = (tab) => {
    if (!translateNode || !tab) return;
    const action = translateOf(tab.url, translationOf(tab.id));
    translateNode.hidden = !action;
    if (!action) return;
    translateNode.lastChild.textContent = action.label;
    translateNode.title = action.revert ? "Show the page in its own language" : "Translate this page into English";
  };
  const translate = async () => {
    const tab = await activeTab();
    const action = tab && translateOf(tab.url, translationOf(tab.id));
    if (!action) return;
    if (!action.revert) asked = tab.id;
    const done = await new Promise((resolve) => {
      const back = (ok) => resolve(!chrome.runtime.lastError && ok !== false);
      try {
        if (action.revert) vivaldi.tabsPrivate.revertTranslatePage(tab.id, back);
        else vivaldi.tabsPrivate.translatePage(tab.id, action.from, "en", back);
      } catch (_) { resolve(false); }
    });
    if (done) return;
    asked = null;
    toast(action.revert ? "Could not show the original page" : "Could not translate the page");
  };

  const fill = (tab) => {
    if (!crumb || !tab) return;
    const { site, title } = crumbOf(tab);
    siteNode.textContent = site;
    crumb.classList.toggle("vm-dia-no-site", !site);
    titleNode.textContent = title;
    crumb.title = tab.url || "";
    showTranslate(tab);
  };
  const make = () => {
    crumb = el("div");
    crumb.id = "vm-dia-crumb";
    siteNode = el("span", "vm-dia-site");
    titleNode = el("span", "vm-dia-title");
    const text = el("button", "vm-dia-text");
    text.append(siteNode, el("span", "vm-dia-sep", "/"), titleNode);
    text.addEventListener("click", () => window.dispatchEvent(new CustomEvent("vm-edit-url")));
    translateNode = el("button", "vm-dia-translate");
    translateNode.hidden = true;
    translateNode.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span>Translate</span>';
    translateNode.addEventListener("click", translate);
    const share = el("button", "vm-dia-share");
    share.title = "Copy link";
    share.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg><span>Copy link</span>';
    share.addEventListener("click", async () => {
      const tab = await activeTab();
      if (!tab?.url) return;
      const copied = await navigator.clipboard?.writeText(tab.url).then(() => true, () => false);
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: copied ? "Copied link" : "Could not copy the link" }));
    });
    crumb.append(text, translateNode, share);
    activeTab().then(fill);
  };

  // The page column's edges, for the row over it and the command bar centred on it: they move with a resized or hidden
  // sidebar, and a sidebar or panels on the right.
  let page = null;
  const pageEdges = new ResizeObserver(() => {
    const browser = document.querySelector("#browser");
    if (!browser || !page) return;
    const style = getComputedStyle(page);
    const { left, right } = columnEdges(page.getBoundingClientRect(), style.marginLeft, style.marginRight, window.innerWidth);
    browser.style.setProperty("--vm-dia-left", `${left}px`);
    browser.style.setProperty("--vm-dia-right", `${right}px`);
  });
  // The row is Vivaldi's and is re-rendered by it: the breadcrumb goes back after Reload whenever it goes missing.
  const place = () => {
    const browser = document.querySelector("#browser");
    if (!browser?.classList.contains("vm-dia")) { crumb?.remove(); return; }
    const container = document.querySelector("#webview-container");
    if (container && container !== page) {
      if (page) pageEdges.unobserve(page);
      page = container;
      pageEdges.observe(page);
    }
    const row = document.querySelector("#main > .mainbar .toolbar-mainbar");
    if (!row) return;
    if (!crumb) make();
    const anchor = row.querySelector("[data-name='Reload']")?.closest(".button-toolbar");
    if (anchor) { if (anchor.nextElementSibling !== crumb) anchor.after(crumb); }
    else if (crumb.parentElement !== row) row.prepend(crumb);
  };

  const start = () => {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; place(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.__vm.onMark(place);
    chrome.windows.getCurrent().then((win) => { ownWindow = win.id; }, () => {});
    chrome.tabs.onActivated.addListener(({ windowId }) => { if (windowId === ownWindow) activeTab().then(fill); });
    // A load that ends (or is abandoned: a download, a 204) settles a pending address back to the page's own.
    chrome.tabs.onUpdated.addListener((_id, change, tab) => {
      if (tab.windowId === ownWindow && tab.active &&
          (change.title !== undefined || change.url !== undefined || change.status !== undefined)) fill(tab);
    });
    chrome.tabs.onReplaced?.addListener(() => activeTab().then(fill));
    // Chromium determines a page's language only once the page is shown, after it loads, and a translation takes a
    // moment: Vivaldi's events say when. They come in bursts, for tabs in every window; Vivaldi's store has the new
    // state by the time they reach this window (measured), the short wait just takes a burst as one.
    let soon = 0;
    const refresh = () => { clearTimeout(soon); soon = setTimeout(() => activeTab().then(showTranslate), 50); };
    const tabsPrivate = vivaldi.tabsPrivate;
    for (const name of ["onLanguageDetermined", "onIsPageTranslatedChanged", "onShowTranslationUI"]) {
      tabsPrivate?.[name]?.addListener(refresh);
    }
    tabsPrivate?.onPageTranslated?.addListener((tabId, _from, _to, error) => {
      refresh();
      if (tabId !== asked) return;
      asked = null;
      if (error && error !== "no_error") toast("Could not translate the page");
    });
    let last = null;
    const follow = (values, writer) => {
      if (values.diaLayout === last) return;
      last = values.diaLayout;
      if (writer) sync(!!last);
      place();
    };
    writes().then((writer) => {
      settings.onChange((values) => follow(values, writer));
      follow(settings.all(), writer);
    });
  };
  // Only once the user's settings are in: the defaults first would switch the layout off and on at every start.
  Promise.all([window.__vm.ready, settings.loaded]).then(([cssLoaded]) => { if (cssLoaded) start(); });
  console.log("[vivarc] Dia layout started");
})();
