// Vivarc: a site's permission question (notifications, location, camera, microphone...) as a card at the top right of the
// page, not a floating address bar. Vivaldi asks inside a popup of its address field (.addressfield-popup-container),
// which Vivarc keeps collapsed; the card is drawn from that popup (the site, what it asks, and a button for each of
// Vivaldi's own buttons, with Vivaldi's labels) and a click on it clicks Vivaldi's button, so Vivaldi records the answer
// exactly as if its own prompt had been clicked. A popup that is not an undecided Allow/Deny question (the site-info panel,
// a decided permission, a device list, anything unseen) is not carded: the field keeps floating for it (vivarc.css).
//
// Measured on Vivaldi 8.2: the popup opens by itself with the focus on its Deny button; Escape or the icon in the field
// closes it, and the request stays pending (the icon stays "undecided"); switching tabs closes it and it does NOT come
// back on return (only the icon is left in the collapsed field), so the card re-opens it then, by pressing that icon;
// navigating or closing the tab ends the request; the Allow button is disabled for the first second.
(() => {
  const W = window.__vm?.workspaces;
  if (!W?.siteRequest) return;
  const POPUP = ".addressfield-popup-container";
  const CARDED = "vm-site-carded"; // on a popup shown as a card: the CSS then leaves the field collapsed
  const HOST = "vm-site-requests";
  const ICON = ".UrlBar-AddressField .button-addressfield.permission-popup.is-undecided:not(.is-dialog-open) button.ToolbarButton-Button";
  const SWITCH_MS = 1500; // a popup that goes within this long of a tab switch went because of the switch
  const cards = new Map(); // popup element -> { card, sig, labels }
  const acted = new WeakSet(); // popups the user answered or dismissed on the card
  const owed = new Set(); // tabs whose card was showing when the user left them: it comes back on return
  let host = null;
  let myWindow = null;
  let activeTab = null;
  let switchedAt = 0;
  let switchedFrom = null;
  let lastOutside = null; // where the cursor was before a popup took it
  let reopenToken = 0;

  const warn = (what, error) => console.warn(`[vivarc] site request ${what}:`, error);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const realButtons = (popup) => [...popup.querySelectorAll(".permission-buttons input")];
  const snapshot = (popup) => {
    const real = realButtons(popup);
    const buttons = real.filter((b) => b.type === "submit" || b.type === "button");
    const others = [...popup.querySelectorAll("input, select, textarea, .device-list-container")].filter((e) => !buttons.includes(e));
    return {
      labelledBy: popup.getAttribute("aria-labelledby"),
      message: popup.querySelector("h1")?.textContent ?? "",
      undecided: !!popup.querySelector(".permission-icon.is-undecided"),
      extras: others.length,
      buttons: buttons.map((b) => ({ label: b.value, type: b.type, disabled: b.disabled })),
    };
  };

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

  const answer = (popup, index) => {
    try {
      const button = realButtons(popup)[index];
      if (!button || button.disabled) return;
      acted.add(popup);
      owed.delete(activeTab);
      button.click();
    } catch (error) { warn("answer", error); }
  };

  // What Vivaldi does to dismiss: close the popup (Escape, or the icon again). The request stays pending.
  const dismiss = (popup) => {
    try {
      acted.add(popup);
      owed.delete(activeTab);
      drop(popup, false);
      const toggle = popup.closest(".button-addressfield")?.querySelector("button.ToolbarButton-Button");
      if (toggle) press(toggle);
      else popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
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
      const buttons = document.querySelector(".window-buttongroup")?.getBoundingClientRect();
      if (buttons && buttons.width > 0 && buttons.height > 0 && buttons.right > window.innerWidth / 2 && buttons.bottom + 8 > top &&
          buttons.left < window.innerWidth - right) top = Math.round(buttons.bottom) + 8;
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
    const text = el("div", "vm-site-text");
    if (request.site) text.append(el("strong", "vm-site-name", request.site), " ");
    text.append(el("span", "vm-site-ask", request.ask));
    const close = el("button", "vm-site-x", "×");
    close.type = "button";
    close.title = "Dismiss (Esc)";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => dismiss(popup));
    head.append(icon, text, close);
    const actions = el("div", "vm-site-actions");
    request.options.forEach((option, i) => {
      const b = el("button", "vm-site-opt", option.label);
      b.type = "button";
      b.disabled = option.disabled;
      b.addEventListener("click", () => answer(popup, i));
      actions.append(b);
    });
    card.append(head, actions);
    card.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(popup); } });
    return card;
  };

  const show = (popup, request) => {
    const entry = cards.get(popup);
    const labels = JSON.stringify([request.site, request.ask, request.options.map((o) => o.label)]);
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
    cards.set(popup, { card, labels });
    place();
    giveBackFocus(popup);
  };

  // `byPopup`: the popup went away by itself (so a tab switch may be why).
  const drop = (popup, byPopup = true) => {
    const entry = cards.get(popup);
    if (!entry) return;
    entry.card.remove();
    cards.delete(popup);
    if (byPopup && !acted.has(popup) && switchedFrom != null && Date.now() - switchedAt < SWITCH_MS) owed.add(switchedFrom);
  };

  const scan = () => {
    try {
      const present = document.querySelector(POPUP);
      if (!present && !cards.size) return;
      const on = window.__vm.cssLoaded && !!document.querySelector("#browser.vm-on");
      const popups = on ? [...document.querySelectorAll(POPUP)] : [];
      for (const popup of [...cards.keys()]) if (!popups.includes(popup)) drop(popup);
      for (const popup of popups) {
        const request = W.siteRequest(snapshot(popup));
        if (!request) { popup.classList.remove(CARDED); drop(popup, false); continue; }
        popup.classList.add(CARDED);
        if (!acted.has(popup)) show(popup, request);
      }
    } catch (error) { warn("scan", error); }
  };

  // Vivaldi does not bring the popup back when the user returns to a tab with a question left on it; the icon is all that
  // stays. Press it, so the popup (and so the card) comes back.
  const reopen = async (tab) => {
    const token = ++reopenToken;
    try {
      for (let i = 0; i < 14; i++) {
        await new Promise((r) => setTimeout(r, 150));
        if (token !== reopenToken || activeTab !== tab || !owed.has(tab)) return;
        const buttons = [...document.querySelectorAll(ICON)];
        if (!buttons.length) continue;
        owed.delete(tab);
        buttons.forEach(press);
        return;
      }
      owed.delete(tab);
    } catch (error) { warn("reopen", error); }
  };

  const onActivated = (info) => {
    try {
      if (myWindow == null || info?.windowId !== myWindow) return;
      const from = activeTab;
      if (from != null && from !== info.tabId) {
        if (cards.size) owed.add(from);
        switchedFrom = from;
        switchedAt = Date.now();
      }
      activeTab = info.tabId;
      if (owed.has(info.tabId)) reopen(info.tabId);
    } catch (error) { warn("tab switch", error); }
  };

  try {
    chrome.windows.getCurrent().then((w) => {
      myWindow = w.id;
      return chrome.tabs.query({ active: true, windowId: myWindow });
    }).then((tabs) => { if (activeTab == null) activeTab = tabs?.[0]?.id ?? null; }, () => {});
    chrome.tabs.onActivated?.addListener(onActivated);
    chrome.tabs.onRemoved?.addListener((id) => { owed.delete(id); });
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
