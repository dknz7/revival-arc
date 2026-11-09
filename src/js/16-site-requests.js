// Vivarc: a site's permission question (notifications, location, camera, microphone...) as a card at the top right of the
// page, not a floating address bar. Vivaldi asks inside a popup of its address field (.addressfield-popup-container),
// which Vivarc keeps collapsed; the card is drawn from that popup (the site, what it asks, and a button for each of
// Vivaldi's own buttons, with Vivaldi's labels) and a click on it clicks Vivaldi's button, so Vivaldi records the answer
// exactly as if its own prompt had been clicked. A popup that is not an undecided Allow/Deny question (the site-info panel,
// a decided permission, a device list, anything unseen) is not carded: the field keeps floating for it (vivarc.css).
//
// Measured on Vivaldi 8.2: the popup opens by itself with the focus on its Deny button; Escape, the icon in the field, or a
// press anywhere outside the popup closes it, and the request stays pending (the icon stays "undecided"); switching tabs
// closes it and it does NOT come back on return (only the icon is left in the collapsed field), so the card re-opens it by
// pressing that icon; navigating or closing the tab ends the request; the Allow button is disabled for the first second.
//
// A question is never lost to the user: when its popup goes without the user answering or dismissing it, it is re-opened
// (at once on the same tab, on return to another); when the user dismisses the card, a small "Site request pending" pill
// stays in its place and brings it back.
(() => {
  const W = window.__vm?.workspaces;
  if (!W?.siteRequest) return;
  const POPUP = ".addressfield-popup-container";
  const CARDED = "vm-site-carded"; // on a popup shown as a card: the CSS then leaves the field collapsed
  const HOST = "vm-site-requests";
  const ICON_ANY = ".UrlBar-AddressField .button-addressfield.permission-popup.is-undecided";
  const ICON = `${ICON_ANY}:not(.is-dialog-open) button.ToolbarButton-Button`;
  const MOVE_MS = 600; // a click this soon after a card left the stack answers nothing: the card below has moved under the pointer
  const AUTO_REOPEN_MAX = 3; // automatic re-opens within AUTO_REOPEN_MS; past that the pill takes over
  const AUTO_REOPEN_MS = 8000;
  const cards = new Map(); // popup element -> { card, labels, tab }
  const acted = new WeakSet(); // popups the user answered or dismissed on the card
  const owed = new Set(); // tabs whose popup went without an answer: it comes back (at once, or on return)
  const dismissed = new Set(); // tabs whose card the user closed: the pill stays while the request is pending
  const reopens = new Map(); // tab -> times of automatic re-opens
  let host = null;
  let pill = null;
  let myWindow = null;
  let activeTab = null;
  let stackMovedAt = 0;
  let lastOutside = null; // where the cursor was before a popup took it
  let reopenToken = 0;

  const warn = (what, error) => console.warn(`[vivarc] site request ${what}:`, error);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // The buttons a card can stand for (the same list the options are read from, at read time and at click time).
  const buttonsOf = (popup) => [...popup.querySelectorAll(".permission-buttons input")].filter((b) => b.type === "submit" || b.type === "button");
  const snapshot = (popup) => {
    const buttons = buttonsOf(popup);
    // Anything else the popup offers (a device list's checkboxes, another button or link; the geolocation notice's link
    // is known and left out) is something the card cannot show, so the popup is not read and floats.
    const others = new Set([...popup.querySelectorAll("input, select, textarea, .device-list-container")].filter((e) => !buttons.includes(e)));
    for (const e of popup.querySelectorAll(".dialog-footer button, .dialog-footer a[href], .dialog-footer [role=button]")) if (!e.closest(".geo-notice")) others.add(e);
    return {
      labelledBy: popup.getAttribute("aria-labelledby"),
      message: popup.querySelector("h1")?.textContent ?? "",
      undecided: !!popup.querySelector(".permission-icon.is-undecided"),
      extras: others.size,
      buttons: buttons.map((b) => ({ label: b.value, type: b.type, disabled: b.disabled })),
    };
  };
  const signature = (request) => JSON.stringify([request.prefix, request.site, request.ask, request.options.map((o) => o.label)]);

  // The events a real click makes; Vivaldi's icon button only answers to the whole sequence (a bare .click() does nothing).
  const press = (button) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, view: window }));
    }
  };

  // Vivaldi's popup takes the cursor when it opens (its Deny button is autofocused). That would leave a hidden button
  // under the user's keys, so the cursor goes back to where it was; the popup stays open.
  const giveBackFocus = (popup) => {
    try {
      if (!popup.contains(document.activeElement)) return;
      let target = lastOutside;
      if (!target || !target.isConnected || target.tagName === "WEBVIEW") {
        const view = activeTab != null ? document.getElementById(String(activeTab)) : null;
        target = view?.tagName === "WEBVIEW" ? view : null;
      }
      target?.focus?.();
    } catch (error) { warn("focus", error); }
  };

  const recentMove = () => Date.now() - stackMovedAt < MOVE_MS;

  // Answers with Vivaldi's own button, if the card still stands for it: the popup still says what the card says, and the
  // button at that place still has the label the card shows. Nothing answers within MOVE_MS of a card leaving the stack.
  const answer = (popup, index, label) => {
    try {
      const entry = cards.get(popup);
      if (!entry || acted.has(popup) || !popup.isConnected || recentMove()) return;
      const request = W.siteRequest(snapshot(popup));
      if (!request || signature(request) !== entry.labels) return;
      const button = buttonsOf(popup)[index];
      if (!button || button.disabled || button.value.trim() !== label) return;
      acted.add(popup);
      owed.delete(entry.tab);
      button.click();
      setTimeout(() => nextQuestion(entry.tab), 600);
    } catch (error) { warn("answer", error); }
  };

  // Another question of the same tab may still be pending (Vivaldi opens a popup per request; one answered leaves the rest).
  const nextQuestion = (tab) => {
    try { if (activeTab === tab && !cards.size && !dismissed.has(tab) && document.querySelector(ICON)) reopen(tab, 0); } catch (error) { warn("next", error); }
  };

  // What Vivaldi does to dismiss: close the popup (Escape, or the icon again). The request stays pending, and the pill stays.
  const dismiss = (popup) => {
    try {
      const entry = cards.get(popup);
      if (!entry || recentMove()) return;
      acted.add(popup);
      owed.delete(entry.tab);
      dismissed.add(entry.tab);
      drop(popup, false);
      const toggle = popup.closest(".button-addressfield")?.querySelector("button.ToolbarButton-Button");
      if (toggle) press(toggle);
      else popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      syncPill();
    } catch (error) { warn("dismiss", error); }
  };

  const hostEl = () => {
    if (host?.isConnected) return host;
    const browser = document.querySelector("#browser");
    if (!browser) return null;
    host = el("div");
    host.id = HOST;
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "Site requests");
    host.setAttribute("aria-live", "polite");
    browser.append(host);
    return host;
  };

  // Top right of the page column, clear of the window's own buttons (Windows draws them at the top right).
  const place = () => {
    try {
      if (!host?.isConnected) return;
      const view = document.querySelector("#webview-container")?.getBoundingClientRect();
      let top = 12;
      let right = 14;
      if (view && view.width > 0) {
        top = Math.max(12, Math.round(view.top) + 12);
        right = Math.max(14, Math.round(window.innerWidth - view.right) + 14);
      }
      // Every button group there is (the Dia layout has two), the ones on screen at the right of the window.
      for (const group of document.querySelectorAll(".window-buttongroup")) {
        const buttons = group.getBoundingClientRect();
        if (buttons.width > 0 && buttons.height > 0 && buttons.bottom > 0 && buttons.right > window.innerWidth / 2 && buttons.bottom + 8 > top &&
            buttons.left < window.innerWidth - right) top = Math.round(buttons.bottom) + 8;
      }
      host.style.setProperty("--vm-sr-top", `${top}px`);
      host.style.setProperty("--vm-sr-right", `${right}px`);
    } catch (error) { warn("place", error); }
  };

  const build = (popup, request) => {
    const card = el("div", "vm-site-card");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", popup.querySelector("h1")?.textContent ?? "Site request");
    const head = el("div", "vm-site-head");
    const icon = el("span", "vm-site-icon");
    const svg = popup.querySelector(".permission-icon svg");
    if (svg) icon.append(svg.cloneNode(true));
    // What Vivaldi says, in its order: the words before the site, the site (bold), what it asks. Text only.
    const text = el("div", "vm-site-text");
    if (request.prefix) text.append(el("span", "vm-site-pre", request.prefix), " ");
    if (request.site) text.append(el("strong", "vm-site-name", request.site), " ");
    text.append(el("span", "vm-site-ask", request.ask));
    const close = el("button", "vm-site-x", "×");
    close.type = "button";
    close.title = "Dismiss (Esc)";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", (e) => { if (e.detail <= 1) dismiss(popup); });
    head.append(icon, text, close);
    const actions = el("div", "vm-site-actions");
    request.options.forEach((option, i) => {
      const b = el("button", "vm-site-opt", option.label);
      b.type = "button";
      b.disabled = option.disabled;
      // A double-click's second click is never an answer: it lands wherever the stack has moved to.
      b.addEventListener("click", (e) => { if (e.detail <= 1) answer(popup, i, option.label); });
      actions.append(b);
    });
    card.append(head, actions);
    card.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(popup); } });
    return card;
  };

  const show = (popup, request) => {
    const entry = cards.get(popup);
    const labels = signature(request);
    if (entry && entry.labels === labels) {
      // Only the buttons' enabled state moved (Allow wakes up a second after the popup opens). Written only when it
      // differs: setting `disabled` to the value it has still queues a mutation record, and the observer watches that
      // attribute, so an unconditional write would re-run the scan forever (measured: it hangs the window).
      entry.card.querySelectorAll(".vm-site-opt").forEach((b, i) => { if (b.disabled !== request.options[i].disabled) b.disabled = request.options[i].disabled; });
      return;
    }
    const container = hostEl();
    if (!container) return;
    const card = build(popup, request);
    if (entry) { entry.card.replaceWith(card); entry.card = card; entry.labels = labels; return; }
    container.append(card);
    cards.set(popup, { card, labels, tab: activeTab });
    dismissed.delete(activeTab);
    place();
    giveBackFocus(popup);
  };

  // `byPopup`: the popup went away by itself, not by the user's answer or dismissal on the card: the question is owed back.
  const drop = (popup, byPopup = true) => {
    const entry = cards.get(popup);
    if (!entry) return;
    entry.card.remove();
    cards.delete(popup);
    stackMovedAt = Date.now();
    if (byPopup && !acted.has(popup) && entry.tab != null) {
      owed.add(entry.tab);
      if (entry.tab === activeTab) reopen(entry.tab, 60);
    }
  };

  // The pill: the question is still pending (the user closed its card, or it could not be brought back) and the field that
  // holds Vivaldi's icon is collapsed, so this is the way back. Shown for the active tab only, while its icon is there.
  const syncPill = () => {
    try {
      const tab = activeTab;
      if (tab != null && dismissed.has(tab) && !document.querySelector(ICON_ANY)) dismissed.delete(tab); // the request is over
      const want = tab != null && dismissed.has(tab) && !cards.size && !!document.querySelector(ICON) && !!hostEl();
      if (want && !pill?.isConnected) {
        pill = el("button", "vm-site-pill", "Site request pending");
        pill.type = "button";
        pill.title = "Show the site's question";
        pill.addEventListener("click", (e) => {
          if (e.detail > 1 || recentMove()) return;
          dismissed.delete(activeTab);
          pill.remove();
          reopen(activeTab, 0);
        });
        host.append(pill);
        place();
      } else if (!want && pill) {
        pill.remove();
        pill = null;
      }
    } catch (error) { warn("pill", error); }
  };

  const scan = () => {
    try {
      const present = document.querySelector(POPUP);
      if (!present && !cards.size && !pill && !dismissed.size) return;
      const on = window.__vm.cssLoaded && !!document.querySelector("#browser.vm-on");
      const popups = on ? [...document.querySelectorAll(POPUP)] : [];
      for (const popup of [...cards.keys()]) if (!popups.includes(popup)) drop(popup);
      for (const popup of popups) {
        const request = W.siteRequest(snapshot(popup));
        if (!request) { popup.classList.remove(CARDED); drop(popup, false); continue; }
        popup.classList.add(CARDED);
        if (!acted.has(popup)) show(popup, request);
      }
      syncPill();
    } catch (error) { warn("scan", error); }
  };

  // Vivaldi does not bring the popup back when the user returns to a tab with a question left on it (nor after a press
  // outside it closed it); the icon is all that stays. Press that one icon (one: a press on a second would count as a press
  // outside the first popup and close it; the next question comes once this one is answered), so the popup, and the card,
  // come back. If it will not, or keeps closing, the pill takes over.
  const reopen = async (tab, first = 150) => {
    const token = ++reopenToken;
    try {
      for (let i = 0; i < 14; i++) {
        await wait(i === 0 ? first : 150);
        if (token !== reopenToken || activeTab !== tab) return;
        if (cards.size) { owed.delete(tab); return; }
        const button = document.querySelector(ICON);
        if (!button) continue;
        owed.delete(tab);
        const now = Date.now();
        const recent = (reopens.get(tab) || []).filter((t) => now - t < AUTO_REOPEN_MS);
        if (recent.length >= AUTO_REOPEN_MAX) { dismissed.add(tab); syncPill(); return; }
        reopens.set(tab, [...recent, now]);
        press(button);
        await wait(500);
        if (token === reopenToken && activeTab === tab && !cards.size && !document.querySelector(POPUP)) { dismissed.add(tab); syncPill(); }
        return;
      }
      owed.delete(tab);
    } catch (error) { warn("reopen", error); }
  };

  const onActivated = (info) => {
    try {
      if (myWindow == null || info?.windowId !== myWindow) return;
      activeTab = info.tabId;
      if (owed.has(info.tabId)) reopen(info.tabId);
      syncPill();
    } catch (error) { warn("tab switch", error); }
  };

  try {
    chrome.windows.getCurrent().then((w) => {
      myWindow = w.id;
      return chrome.tabs.query({ active: true, windowId: myWindow });
    }).then((tabs) => { if (activeTab == null) activeTab = tabs?.[0]?.id ?? null; }, () => {});
    chrome.tabs.onActivated?.addListener(onActivated);
    chrome.tabs.onRemoved?.addListener((id) => { owed.delete(id); dismissed.delete(id); reopens.delete(id); });
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (t && t.nodeType === 1 && !t.closest?.(`${POPUP}, #${HOST}`)) lastOutside = t;
    }, true);
    window.addEventListener("resize", place);
    // Vivaldi closes the popup (the request stays pending) on a press anywhere outside it, and the card is outside it:
    // measured, a real click on the card's button closed the popup before the click could answer it. A press on the card
    // therefore goes no further than the card (window capture runs before Vivaldi's listeners).
    for (const type of ["pointerdown", "mousedown", "touchstart"]) {
      window.addEventListener(type, (e) => { if (e.target?.closest?.(`#${HOST}`)) e.stopImmediatePropagation(); }, true);
    }
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    console.log("[vivarc] site requests started");
  } catch (error) {
    warn("start", error);
  }
})();
