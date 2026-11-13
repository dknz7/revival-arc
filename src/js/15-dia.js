// Vivarc's Dia layout (setting "Dia layout"): a slim row over the page (Vivaldi's menu, a hide-sidebar button, back, forward, reload, a
// "site / title" breadcrumb, three icon buttons: a Shield (Vivaldi's site info and blocker), Copy link and Translate (on a
// page not in English), then extensions and the window buttons) with the sidebar up to the window's top.
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

  // Whether the profile has the layout on, from Vivaldi's prefs alone: they hold the layout's own values (target) only
  // while it is on, since off puts the address row back off. A private window reads it this way (01-settings.js): the
  // normal windows' store and settings channel are not reachable from its off-the-record profile.
  // The top row's contents count only as far as they tell the Dia row from the user's own: an Arc-layout profile with
  // Vivaldi's address row switched on by hand (the frame off is Vivaldi's own default on Windows) shows the user's row,
  // which is Vivaldi's default one or an edit of it. Vivaldi's default row (measured on 8.3) has an address field, a
  // PanelWidthSpacer and a plain Spacer, and no FlexibleSpacer. The Dia row may have been edited in Vivaldi's toolbar
  // editor since, so it counts while it has no address field, keeps the layout's FlexibleSpacer and has no
  // PanelWidthSpacer.
  const inherits = (current, windows) => current?.[ADDRESS] === true && (!windows || current?.[FRAME] === false) &&
    Array.isArray(current?.[ROW]) && !current[ROW].includes("AddressField") && current[ROW].includes("FlexibleSpacer") &&
    !current[ROW].includes("PanelWidthSpacer");

  // What the breadcrumb shows for a tab: its site (a web page's host) and its title.
  const crumbOf = (tab) => {
    const url = tab?.pendingUrl || tab?.url || "";
    if (BLANK.test(url) && !SECTION.test(url)) return { site: "", title: window.__vm.workspaces?.startTitle?.(tab) || "New Tab" };
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
  // The button is an icon: `label` is its tooltip and accessible name, `state` ("translated", "translating" or "idle") its look.
  const translateOf = (url, state) => {
    if (!/^https?:/i.test(url || "")) return null;
    if (state?.isTranslated) return { revert: true, label: "Show original", state: "translated" };
    const from = state?.pageLanguage || "";
    if (!from || from === "und" || /^en(-|$)/i.test(from)) return null;
    const translating = state.translateStep === "translating";
    return { revert: false, from, label: translating ? "Translating…" : "Translate", state: translating ? "translating" : "idle" };
  };

  // Vivaldi's translation state per tab lives in its own store, which its address-bar button reads. A mod has no API
  // for it: the store is found in webpack's modules as findRemover (07-workspaces.js) finds Vivaldi's workspace manager.
  // Vivaldi's webpack require from its chunk array, the entry taken out again at once: webpack keeps a pushed entry, and
  // on the background page it would be a reference into this window after the window closes (07-workspaces.js,
  // requireOf; this file is also loaded on its own by its tests, so it has its own copy).
  const requireOf = (chunks, tag) => {
    let load;
    const entry = [[Symbol(tag)], {}, (require) => { load = require; }];
    chunks.push(entry);
    const at = typeof chunks.lastIndexOf === "function" ? chunks.lastIndexOf(entry) : -1;
    if (at >= 0) chunks.splice(at, 1);
    return load;
  };
  const findTranslation = (chunks) => {
    try {
      const load = requireOf(chunks, "vivarc-translation");
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

  // Vivaldi's translator takes its own language codes, not always the page's: taobao.com says zh-CN, and translating
  // from "zh-CN" (or "auto") fails with unsupported_language while "zh-Hans" works (measured on 8.2). Vivaldi's own
  // popup converts with getTranslationCode; this finds it like the store, and falls back to that function's 8.2 table.
  const CODES_82 = { "en-US": "en", "es-ES": "es", kmr: "ku", nb: "no", "pt-PT": "pt", sr: "sr-Cyrl", "zh-CN": "zh-Hans",
    "zh-TW": "zh-Hant", "de-CH": "de", "en-GB": "en", "ja-KS": "ja", "sr-Latn": "sr", nn: "no", iw: "he", me: "hr" };
  const translatorCode = (code, convert) => {
    if (typeof convert === "function") { try { return convert(code) || code; } catch (_) {} }
    return CODES_82[code] || code;
  };
  const findCodes = (chunks) => {
    try {
      const load = requireOf(chunks, "vivarc-translation-codes");
      for (const [id, factory] of Object.entries(load?.m || {})) {
        if (!String(factory).includes("getTranslationCode")) continue;
        let exported;
        try { exported = load(id); } catch (_) { continue; }
        for (const codes of Object.values(exported || {})) {
          if (typeof codes?.getTranslationCode === "function") return (code) => codes.getTranslationCode(code);
        }
      }
    } catch (_) {}
    return null;
  };

  // The sidebar is Vivaldi's tab bar, and the button after Vivaldi's menu button hides and shows it in this window only
  // (12-sidebar-hide.js). The tooltip says what a click does, then Vivarc's own key, which does the same (named as the
  // spaces hint names keys: Cmd on a Mac).
  const sidebarLabel = (shown, windows) => `${shown ? "Hide" : "Show"} sidebar (${windows ? "Ctrl" : "Cmd"}+S)`;

  // What of the top row's own buttons fits in `content` px (the row's width less its reserved window-button padding).
  // `fixed` is what is never dropped (Vivaldi's menu, the sidebar button, Back); Forward then Reload go when even the
  // empty breadcrumb would have no room. "" = all shown, "nofwd", "noreload" (Forward and Reload gone), or "tight":
  // not even the fixed buttons fit, so the row slides left over the top of the sidebar by what is missing (--vm-dia-need) rather than
  // lose the sidebar button or overlap the window buttons.
  // Decided from natural widths only, never from what is shown now, so a change cannot undo itself.
  const rowFit = (content, { fixed, forward, reload }) => {
    if (content >= fixed + forward + reload) return "";
    if (content >= fixed + reload) return "nofwd";
    if (content >= fixed) return "noreload";
    return "tight";
  };

  // The breadcrumb's icon buttons, left to right, each Vivaldi's 28-unit toolbar grid with its 1.2 stroke in currentColor
  // (so they follow the theme like the row's own buttons). Translate is 文 and A with two arrows between them.
  const CRUMB_BUTTONS = ["shield", "share", "translate"];
  const svg = (paths) => `<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    shield: svg('<path d="M14 5 21 7.6v5.6c0 4.4-2.9 7.9-7 9.8-4.1-1.9-7-5.4-7-9.8V7.6Z"/>'),
    share: svg('<path d="M14 5.5v10"/><path d="m10.5 9 3.5-3.5L17.5 9"/><path d="M9 13v7a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 19 20v-7"/>'),
    translate: svg('<path d="M5 8h8"/><path d="M9 5.5V8"/><path d="M6.5 9.5c1 2.6 2.8 4.6 6 5.5"/><path d="M11.5 9.5c-1 2.6-2.8 4.6-6 5.5"/>' +
      '<path d="m14.5 23 3.5-9 3.5 9"/><path d="M15.8 20h4.4"/><path d="M16 5.5c3 0 5.5 1.8 5.5 4.5"/><path d="m19.8 8.6 1.7 1.6 1.6-1.7"/>' +
      '<path d="M12 22.5c-3 0-5.5-1.8-5.5-4.5"/><path d="m8.2 19.4-1.7-1.6-1.6 1.7"/>'),
  };
  // What gives way first as the page column narrows (vivarc.css, container queries on the breadcrumb): the title, then
  // Translate, then Copy link (Ctrl+Shift+C does the same), then the Shield, last of Vivarc's because with the address field
  // collapsed it is the only way to the site's info. After them rowFit drops Forward, then Reload.
  const GIVE_WAY = ["title", "translate", "share", "shield"];

  window.__vm.dia = { target, plan, inherits, crumbOf, columnEdges, translateOf, findTranslation, translatorCode, findCodes, sidebarLabel, rowFit, ROW_ITEMS,
    CRUMB_BUTTONS, ICONS, GIVE_WAY };
  if (!window.__vm.store) return;

  const { store, settings } = window.__vm;
  const windows = !!window.__vm.windows;
  const KEPT = "dia:kept";
  const prefs = {
    get: async (path) => (await vivaldi.prefs.get(path))?.value,
    set: (path, value) => vivaldi.prefs.set({ path, value }),
  };
  const readTarget = async () => Object.fromEntries(await Promise.all(Object.keys(target(windows)).map(async (path) => [path, await prefs.get(path)])));
  // Read only: whether the normal windows have the layout on (inherits). A private window starts from it.
  window.__vm.dia.inherited = async () => inherits(await readTarget(), windows);

  // Every window runs this and all of them hear the switch: each step is idempotent, and they queue per window.
  // The user's values are kept before anything changes, and forgotten only once they are back: a restore cut short
  // (a window closed, Vivaldi quit) leaves them for the next window to finish.
  let queue = Promise.resolve();
  const sync = (on) => {
    queue = queue.then(async () => {
      const current = await readTarget();
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
  let codes; // Vivaldi's getTranslationCode, looked up at the first translation (null: CODES_82 is used)
  const codesOf = () => {
    if (codes === undefined) {
      codes = findCodes(window.webpackChunkgapp_browser_react) ||
        findCodes(chrome.extension?.getBackgroundPage?.()?.webpackChunkgapp_browser_react);
    }
    return codes;
  };
  const showTranslate = (tab) => {
    if (!translateNode || !tab) return;
    const action = translateOf(tab.url, translationOf(tab.id));
    translateNode.hidden = !action;
    if (!action) return;
    const tip = action.revert ? "Show original (this page is translated into English)"
      : action.state === "translating" ? "Translating… (click to finish)" : "Translate this page into English";
    translateNode.title = tip;
    translateNode.setAttribute("aria-label", action.label);
    translateNode.dataset.state = action.state;
    translateNode.setAttribute("aria-pressed", String(action.revert));
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
        else vivaldi.tabsPrivate.translatePage(tab.id, translatorCode(action.from, codesOf()), "en", back);
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
  // An icon button of the row: a tooltip and an accessible name, and a press never takes the cursor from the page.
  const iconButton = (name, label) => {
    const b = el("button", `vm-dia-icon vm-dia-${name}`);
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = ICONS[name];
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };
  const make = () => {
    crumb = el("div");
    crumb.id = "vm-dia-crumb";
    siteNode = el("span", "vm-dia-site");
    titleNode = el("span", "vm-dia-title");
    const text = el("button", "vm-dia-text");
    text.append(siteNode, el("span", "vm-dia-sep", "/"), titleNode);
    text.addEventListener("click", () => window.dispatchEvent(new CustomEvent("vm-edit-url")));
    shieldNode = iconButton("shield", "Site info and tracker blocking");
    shieldNode.setAttribute("aria-haspopup", "dialog");
    shieldNode.setAttribute("aria-expanded", "false");
    shieldNode.addEventListener("click", shieldClick);
    const share = iconButton("share", "Copy link");
    share.addEventListener("click", async () => {
      const tab = await activeTab();
      if (!tab?.url) return;
      const copied = await navigator.clipboard?.writeText(tab.url).then(() => true, () => false);
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: copied ? "Copied link" : "Could not copy the link" }));
    });
    translateNode = iconButton("translate", "Translate");
    translateNode.hidden = true;
    translateNode.addEventListener("click", translate);
    const actions = el("span", "vm-dia-actions");
    actions.append(shieldNode, share, translateNode);
    crumb.append(text, actions);
    activeTab().then(fill);
  };

  // ---- Shield: Vivaldi's own site-info popup (security, cookies, site settings, JavaScript, the Ad and Tracker Blocker
  // level, Privacy Report), opened by pressing Vivaldi's site-info button in the collapsed address field the way
  // 16-site-requests.js presses a permission icon (window.__vm.press, marked as Vivarc's own). Measured on 8.3: the popup is
  // a `.SiteInfo.button-popup` inside that button (not an .addressfield-popup-container), it takes the focus, a second press
  // of the button closes it, and so do Escape (the focus then goes back to the page) and any press outside it.
  // While it is open #browser has vm-shield-open: the CSS keeps the field collapsed and shows the popup alone, fixed under
  // the Shield. Anything else Vivaldi opens there (unrecognised) drops the mark, so it floats as before.
  const SITE_INFO_BUTTON = "#tabs-tabbar-container .UrlBar-AddressField .SiteInfoButton button.ToolbarButton-Button";
  const SITE_INFO = "#tabs-tabbar-container .UrlBar-AddressField .SiteInfoButton > .SiteInfo.button-popup";
  const SHIELD_OPEN = "vm-shield-open";
  let shieldNode = null;
  let shieldWatch = null;
  let shieldClosedAt = 0;
  let shieldWasOpen = false;
  const siteInfo = () => {
    const pop = document.querySelector(SITE_INFO);
    return pop?.querySelector(".SiteInfo-Content, .SiteInfo-Header") ? pop : null;
  };
  // Another popup of the address field than the site info (a carded permission question does not count: it is shown as a card).
  const otherPopup = () => [...document.querySelectorAll("#tabs-tabbar-container .UrlBar-AddressField :is(.addressfield-popup-container, .button-popup)")]
    .some((p) => !p.matches(".SiteInfo.button-popup, .vm-site-carded"));
  const shieldWarn = (what, error) => console.warn(`[vivarc] Dia layout: shield ${what}:`, error);
  // Under the Shield, right-aligned to it and kept inside the window. Measured, then corrected by any offset a containing
  // block other than the window gives a fixed box.
  // Written only when they change: the tab bar's mutations (titles, favicons) call this while the popup is open.
  const shieldVars = (browser, x, y) => {
    if (browser.style.getPropertyValue("--vm-shield-x") !== `${x}px`) browser.style.setProperty("--vm-shield-x", `${x}px`);
    if (browser.style.getPropertyValue("--vm-shield-y") !== `${y}px`) browser.style.setProperty("--vm-shield-y", `${y}px`);
  };
  const shieldPlace = () => {
    try {
      const pop = siteInfo();
      const browser = document.querySelector("#browser");
      if (!pop || !browser || !shieldNode?.isConnected) return;
      const b = shieldNode.getBoundingClientRect();
      const w = pop.offsetWidth || 330;
      let x = Math.round(Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8)));
      let y = Math.round(b.bottom + 6);
      shieldVars(browser, x, y);
      const at = pop.getBoundingClientRect();
      if (Math.abs(at.left - x) > 1 || Math.abs(at.top - y) > 1) {
        x -= Math.round(at.left - x);
        y -= Math.round(at.top - y);
        shieldVars(browser, x, y);
      }
    } catch (error) { shieldWarn("place", error); }
  };
  // The popup is gone (or something else opened): the mark goes. `refocus`: the cursor is left nowhere useful (the popup
  // that had it is gone), so the page gets it, as Escape does.
  const shieldEnd = (refocus) => {
    try {
      shieldWatch?.disconnect();
      shieldWatch = null;
      shieldClosedAt = Date.now();
      document.querySelector("#browser")?.classList.remove(SHIELD_OPEN);
      shieldNode?.setAttribute("aria-expanded", "false");
      const a = document.activeElement;
      if (refocus && !document.querySelector(".addressfield-popup-container") && (!a || a === document.body || a.closest?.(".UrlBar-AddressField"))) {
        activeTab().then((tab) => {
          const view = tab && document.getElementById(String(tab.id));
          if (view?.tagName === "WEBVIEW" && (document.activeElement === document.body || !document.activeElement)) view.focus();
        }, () => {});
      }
    } catch (error) { shieldWarn("close", error); }
  };
  const shieldOpen = () => {
    const button = document.querySelector(SITE_INFO_BUTTON);
    const browser = document.querySelector("#browser");
    if (!button || !browser) { toast("Site info is not available for this page"); return; }
    shieldWatch?.disconnect(); // one watch at a time
    browser.classList.add(SHIELD_OPEN);
    shieldNode.setAttribute("aria-expanded", "true");
    const started = Date.now();
    let seen = false;
    let watch = null;
    const check = () => {
      try {
        if (!watch || shieldWatch !== watch) return; // a later open (or a close) owns the state now
        if (otherPopup()) { shieldEnd(false); return; } // not ours to hide: it floats as before
        if (siteInfo()) { seen = true; document.querySelector("#browser")?.classList.add(SHIELD_OPEN); shieldPlace(); return; }
        if (seen || Date.now() - started > 800) shieldEnd(true);
      } catch (error) { shieldWarn("watch", error); shieldEnd(false); }
    };
    // The whole UI, not the tab bar found now: Vivaldi may put up a new tab bar (and a new popup in it) while the popup is
    // open, and a watch left on the old one would keep the mark with no popup to show. At most one check a frame: the whole
    // UI changes often (titles, the sidebar, a pending question's pill), and each check measures. Until the popup is first
    // seen every change is checked at once, so it is placed before it is ever painted.
    let queued = 0;
    watch = shieldWatch = new MutationObserver(() => {
      if (!seen) { check(); return; }
      if (!queued) queued = requestAnimationFrame(() => { queued = 0; check(); });
    });
    watch.observe(document.body, { childList: true, subtree: true });
    window.__vm.press(button);
    check();
    setTimeout(check, 850); // nothing opened at all: the mark must not stay
  };
  // Closes the popup the way Escape does (never a second press of Vivaldi's button: that toggles, and could open it again).
  const shieldClose = () => {
    const pop = siteInfo();
    pop?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  };
  // A press on the Shield while the popup is open closes it (Vivaldi closes it on any press outside it, the Shield too): the
  // click that follows must not open it again. Read at the press, before Vivaldi's own handlers run.
  const shieldClick = (e) => {
    try {
      const wasOpen = e?.detail === 0 ? !!shieldWatch || !!siteInfo() : shieldWasOpen; // detail 0: Enter or Space
      shieldWasOpen = false;
      if (wasOpen) {
        shieldClose();
        shieldEnd(true);
        return;
      }
      shieldOpen();
    } catch (error) { shieldWarn("click", error); shieldEnd(false); }
  };


  // The hide-sidebar button: hides and shows this window's sidebar (12-sidebar-hide.js), and its tooltip follows that
  // state, so the key (Ctrl+S) changes it too.
  let sideNode = null;
  let sideWarned = false;
  const sideWarn = (message) => {
    if (sideWarned) return;
    sideWarned = true;
    console.warn(`[vivarc] Dia layout: ${message}`);
  };
  const sideLabel = () => {
    if (!sideNode) return;
    const label = sidebarLabel(!window.__vm.sidebarHide?.hidden(), windows);
    sideNode.title = label;
    sideNode.setAttribute("aria-label", label);
  };
  const sideToggle = async () => {
    try {
      if (!window.__vm.sidebarHide) return sideWarn("the sidebar hide module is missing, the sidebar button does nothing");
      await window.__vm.sidebarHide.toggle();
    } catch (error) {
      console.warn("[vivarc] Dia layout: could not hide or show the sidebar:", error);
    }
  };
  const makeSide = () => {
    sideNode = el("button", "vm-dia-sidebar");
    sideNode.id = "vm-dia-sidebar";
    sideNode.type = "button";
    sideNode.tabIndex = -1;
    sideNode.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/></svg>';
    sideNode.addEventListener("click", sideToggle);
    sideLabel();
  };
  // Right after Vivaldi's menu button, before Back (on a Mac, which has no in-window menu, just before Back). Back is the
  // anchor that must be there: without it the button stays out of the row, with one warning.
  const placeSide = (row) => {
    const back = row.querySelector("[data-name='Back']")?.closest(".button-toolbar");
    if (!back || back.parentElement !== row) {
      sideNode?.remove();
      sideWarn("Back not found in the top row, no sidebar button");
      return;
    }
    if (!sideNode) makeSide();
    const menu = row.querySelector(":scope > button.vivaldi");
    if (menu && menu.parentElement === row) { if (menu.nextElementSibling !== sideNode) menu.after(sideNode); }
    else if (back.previousElementSibling !== sideNode) back.before(sideNode);
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
  // The row's own buttons never shrink; when the page column is too narrow, whole ones drop out (rowFit), as data-vm-dia-fit
  // on #browser for the CSS. Measured when the row's width changes (one frame later, so a drag resizes without thrashing).
  // A button's natural width is remembered while it is shown, so the choice never depends on what is hidden now.
  const natural = { forward: 37, reload: 37 };
  const outerWidth = (node) => {
    const style = getComputedStyle(node);
    return node.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
  };
  const fitRow = () => {
    const browser = document.querySelector("#browser");
    const row = document.querySelector("#main > .mainbar .toolbar-mainbar");
    // Not while Vivaldi has the address row off (the row is display: none then, vivarc.css): everything in it measures 0,
    // and 0 would be remembered as Forward's and Reload's natural widths. It is measured again once it shows (rowSize).
    if (!browser || !row || browser.classList.contains("address-top-off")) return;
    const style = getComputedStyle(row);
    const reserved = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    // The page column's own width, from its edges rather than the row's (a row that has slid left over the sidebar, see
    // "tight", would otherwise change what it is measured by); a Mac's traffic-light inset is the row's own offset.
    const edge = (name) => parseFloat(browser.style.getPropertyValue(name)) || 0;
    const inset = Math.max(0, row.getBoundingClientRect().left - edge("--vm-dia-left"));
    const content = window.innerWidth - edge("--vm-dia-left") - inset - edge("--vm-dia-right") - reserved;
    let fixed = 0;
    for (const child of row.children) {
      if (child === crumb || child.matches(".window-buttongroup, .toolbar-spacer-flexible, .toolbar-extensions")) continue;
      const name = child.querySelector?.("[data-name]")?.dataset.name;
      const own = name === "Forward" ? "forward" : name === "Reload" ? "reload" : null;
      if (getComputedStyle(child).display === "none") continue;
      const width = outerWidth(child);
      if (own) natural[own] = width;
      else fixed += width;
    }
    const fit = rowFit(content, { fixed, ...natural });
    if (fit) browser.dataset.vmDiaFit = fit; else delete browser.dataset.vmDiaFit;
    if (fit === "tight") browser.style.setProperty("--vm-dia-need", `${Math.ceil(fixed + reserved)}px`);
    else browser.style.removeProperty("--vm-dia-need");
  };
  let fitting = 0;
  const refit = () => { cancelAnimationFrame(fitting); fitting = requestAnimationFrame(fitRow); };
  const rowSize = new ResizeObserver(refit);
  let watchedRow = null;

  // The row is Vivaldi's and is re-rendered by it: the breadcrumb goes back after Reload whenever it goes missing.
  const place = () => {
    const browser = document.querySelector("#browser");
    if (!browser?.classList.contains("vm-dia")) { if (shieldWatch) shieldEnd(false); crumb?.remove(); sideNode?.remove(); delete browser?.dataset.vmDiaFit; return; }
    const container = document.querySelector("#webview-container");
    if (container && container !== page) {
      if (page) pageEdges.unobserve(page);
      page = container;
      pageEdges.observe(page);
    }
    const row = document.querySelector("#main > .mainbar .toolbar-mainbar");
    if (!row) return;
    if (row !== watchedRow) {
      if (watchedRow) rowSize.unobserve(watchedRow);
      watchedRow = row;
      rowSize.observe(row);
    }
    if (!crumb) make();
    const anchor = row.querySelector("[data-name='Reload']")?.closest(".button-toolbar");
    if (anchor) { if (anchor.nextElementSibling !== crumb) anchor.after(crumb); }
    else if (crumb.parentElement !== row) row.prepend(crumb);
    placeSide(row);
    refit();
  };

  const start = () => {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; place(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.__vm.onMark(place);
    // Vivaldi re-renders #browser's classes: the Shield's mark goes back while its popup is open.
    window.__vm.onMark((browser) => { if (shieldWatch && siteInfo()) browser.classList.add(SHIELD_OPEN); });
    window.addEventListener?.("pointerdown", (e) => {
      if (!e.target?.closest?.(".vm-dia-shield")) return;
      shieldWasOpen = !!shieldWatch || !!siteInfo() || Date.now() - shieldClosedAt < 300;
    }, true);
    window.addEventListener?.("resize", () => { if (shieldWatch) shieldPlace(); });
    // A click on the page does not reach Vivaldi's outside-press closer (measured on 8.3: the popup loses the focus to the
    // page, no focusin follows in this document, and Vivaldi's own popup stays open), so the page taking the focus from
    // the Shield's popup closes it. Another app taking the focus leaves document.activeElement on the popup: it stays.
    document.addEventListener?.("focusout", (e) => {
      try {
        if (!shieldWatch || !e.target?.closest?.(".SiteInfo")) return;
        setTimeout(() => {
          try { if (document.activeElement?.tagName === "WEBVIEW" && siteInfo()) shieldClose(); } catch (error) { shieldWarn("page focus", error); }
        }, 0);
      } catch (error) { shieldWarn("page focus", error); }
    }, true);
    // The keys that ask for the address field (as 20-command-bar.js counts them) while the popup is open: the field is
    // hidden then and cannot take the cursor, so the mark goes first and the field gets it (Vivaldi's own try may have
    // come first and failed). With this window's sidebar hidden the field has nowhere to show: the popup closes, and the
    // command bar takes the key instead (12-sidebar-hide.js).
    const toField = () => {
      if (document.querySelector("#browser.vm-sidebar-hidden")) { shieldClose(); shieldEnd(false); return; }
      shieldEnd(false);
      setTimeout(() => {
        try {
          const field = document.querySelector("#tabs-tabbar-container #urlFieldInput");
          if (field && document.activeElement !== field) { field.focus(); field.select?.(); }
        } catch (error) { shieldWarn("address field", error); }
      }, 0);
    };
    const ASK = new Set(["ctrl+l", "l+meta", "f6", "alt+d"].map((k) => window.__vm.normalise?.(k) ?? k));
    // Every window hears every key: only the one it was pressed in acts (00-core.js passes that window's id).
    window.__vm.onShortcut?.((key, _combo, pressedIn) => {
      if (shieldWatch && ASK.has(key) && (pressedIn != null ? pressedIn === window.vivaldiWindowId : document.hasFocus())) toField();
    });
    document.addEventListener?.("keydown", (e) => {
      if (shieldWatch && (e.key === "F6" || ((e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === "l") || (e.altKey && e.key?.toLowerCase() === "d"))) toField();
    }, true);
    // The cursor going anywhere else in the UI while the popup is open (the command bar, a Vivarc field): the mark goes,
    // so nothing the user types into is kept hidden; the field floats with what it holds, as before.
    document.addEventListener?.("focusin", (e) => {
      try {
        const t = e.target;
        if (!shieldWatch || !t || t === document.body || t.closest?.(".SiteInfoButton, .vm-dia-shield")) return;
        shieldEnd(false);
      } catch (error) { shieldWarn("focus", error); }
    }, true);
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
    // The sidebar button's tooltip follows this window's hide, whichever of the button and Ctrl+S changed it.
    window.__vm.sidebarHide?.onChange(sideLabel);
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
