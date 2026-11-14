// Vivarc: a site's permission question (notifications, location, camera, microphone...) as a card in Vivarc's notifications
// (17-notify.js: a toast under the breadcrumb or the sidebar's URL bar, or a row of the command bar's fly-up while the bar is
// open), not a floating address bar. Vivaldi asks inside a popup of its address field (.addressfield-popup-container),
// which Vivarc keeps collapsed; the card is drawn from that popup (the site, what it asks, and a button for each of
// Vivaldi's own buttons, with Vivaldi's labels) and a click on it clicks Vivaldi's button, so Vivaldi records the answer
// exactly as if its own prompt had been clicked. A popup that is not an undecided Allow/Deny question (the site-info panel,
// a decided permission, a device list, anything unseen) is not carded: Vivaldi's popup itself drops from where the toasts do
// (vivarc.css), the field staying collapsed.
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
  const NOTE = ".vm-site-card, .vm-site-pill"; // Vivarc's own: a press or a focus there is not "outside" Vivaldi's popup
  const STOP = "#vm-notify, #vm-cmd .vm-cmd-stack"; // presses that must not reach Vivaldi's outside-press closer (below)
  const ICON_ANY = ".UrlBar-AddressField .button-addressfield.permission-popup.is-undecided";
  const ICON = `${ICON_ANY}:not(.is-dialog-open) button.ToolbarButton-Button`;
  const MOVE_MS = 600; // a click this soon after a card left the stack answers nothing: the card below has moved under the pointer
  const AUTO_REOPEN_MAX = 3; // automatic re-opens within AUTO_REOPEN_MS; past that the pill takes over
  const AUTO_REOPEN_MS = 8000;
  const cards = new Map(); // popup element -> { card, labels, tab, id }
  const acted = new WeakSet(); // popups the user answered or dismissed on the card
  const owed = new Set(); // tabs whose popup went without an answer: it comes back (at once, or on return)
  const dismissed = new Set(); // tabs whose card the user closed: the pill stays while the request is pending
  const reopens = new Map(); // tab -> times of automatic re-opens
  let pill = null;
  let cardSeq = 0;
  let previousTab = null; // the tab active before the last switch, and when that switch was (show)
  let switchedAt = 0;
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
  // Marked as Vivarc's own (window.__vm.synthetic, 00-core.js), so Vivarc's outside-press closers (its menus and popovers) and
  // the address-field focus guard of 20-command-bar.js do not take it for the user's; the focus Vivaldi's popup then takes
  // is marked for a moment too. The Dia layout's Shield (15-dia.js) presses the same way.
  const press = (button) => window.__vm.press(button);
  // Whether the user is busy in something of Vivarc's own: a menu or popover, an inline name field, the command bar, the Dia
  // layout's Shield popup (Vivaldi's site info, 15-dia.js), or the cursor in any other text entry outside the card. The
  // reopened popup would take the cursor (its Deny button is autofocused), an inline rename ends, unchanged, when its field
  // loses focus, and pressing the question's icon is a press outside the Shield's popup, which closes it. A menu stays
  // "open" for a moment after it closes: the item picked in it (Rename...) opens its field a tick later.
  // `barToo`: whether the open command bar counts. The re-open never counts it (reopen, fix round 1): the fly-up shows the
  // question, and its popup cannot take the bar's cursor (it lives in Vivaldi's hidden field).
  let busyAt = 0;
  let shieldHeld = false; // the Shield's button is pressed and not yet released (see the listeners at the end)
  const busy = (barToo = true) => {
    if (shieldHeld) busyAt = Date.now();
    const a = document.activeElement;
    const inBar = !!a?.closest?.("#vm-cmd");
    const typing = !!a && !a.closest?.(`${NOTE}, ${POPUP}`) && !(inBar && !barToo) && (a.matches?.("input, textarea, [contenteditable]") || a.isContentEditable);
    if (document.querySelector(`.vm-menu, .vm-theme-pop, .vm-set-card, .vm-rename, .vm-rename-float, .vm-space-input, ${barToo ? "#vm-cmd, " : ""}#browser.vm-shield-open, .UrlBar-AddressField .SiteInfo.button-popup`) || typing) busyAt = Date.now();
    return Date.now() - busyAt < 500;
  };
  const menuOpen = busy;
  const barOpen = () => !!document.querySelector("#vm-cmd");
  // The Shield's popup has no time limit: while it is open the question waits in its pill however long that is.
  const shieldUp = () => shieldHeld || !!document.querySelector("#browser.vm-shield-open, .UrlBar-AddressField .SiteInfo.button-popup");
  const moved = () => { stackMovedAt = Date.now(); }; // something clickable has just appeared or gone where the pointer may be

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

  // A click on a card button leaves the cursor on it, whether or not the click did anything (a refused click does not):
  // a later Space or Enter would then answer. The cursor goes back to the page (or where it was before the popup).
  const releaseFocus = () => {
    try {
      const a = document.activeElement;
      if (!a || !a.closest?.(NOTE)) return;
      let target = lastOutside;
      if (!target || !target.isConnected || target.tagName === "WEBVIEW") {
        const view = activeTab != null ? document.getElementById(String(activeTab)) : null;
        target = view?.tagName === "WEBVIEW" ? view : null;
      }
      if (target) target.focus?.(); else a.blur();
    } catch (error) { warn("release focus", error); }
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
    try { if (activeTab === tab && !cards.size && !dismissed.has(tab) && document.querySelector(ICON)) reopen(tab, 0, false, barOpen()); } catch (error) { warn("next", error); }
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

  const notify = () => window.__vm.notify;

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
    const words = (r) => {
      text.replaceChildren();
      if (r.prefix) text.append(el("span", "vm-site-pre", r.prefix), " ");
      if (r.site) text.append(el("strong", "vm-site-name", r.site), " ");
      text.append(el("span", "vm-site-ask", r.ask));
    };
    words(request);
    // Vivaldi's protocol-handler question is denied when its popup is closed: the close button says so, and so does the card.
    const close = el("button", "vm-site-x", request.closeDenies ? "Deny" : "×");
    close.type = "button";
    close.title = request.closeDenies ? "Deny (closing this question denies it)" : "Dismiss (Esc)";
    close.setAttribute("aria-label", request.closeDenies ? "Deny" : "Dismiss");
    if (request.closeDenies) close.classList.add("vm-site-x-deny");
    close.addEventListener("click", (e) => { try { if (e.detail <= 1) dismiss(popup); } finally { releaseFocus(); } });
    head.append(icon, text, close);
    const actions = el("div", "vm-site-actions");
    request.options.forEach((option, i) => {
      const b = el("button", "vm-site-opt", option.label);
      b.type = "button";
      b.disabled = option.disabled;
      // A double-click's second click is never an answer: it lands wherever the stack has moved to.
      b.addEventListener("click", (e) => { try { if (e.detail <= 1) answer(popup, i, option.label); } finally { releaseFocus(); } });
      actions.append(b);
    });
    // Two short buttons sit on the right of the message; longer ones, or more, under it (17-notify.js, buttonsFit). Decided
    // again when the words change.
    card.append(head);
    const layout = () => {
      const inline = !request.closeDenies && !!window.__vm.notifyLogic?.buttonsFit(request.options.map((o) => o.label), text.textContent);
      card.classList.toggle("vm-site-inline", inline);
      if (inline) head.insertBefore(actions, close);
      else head.after(actions);
    };
    layout();
    // Vivaldi's raw permission names ("window-placement", "local-fonts", with no site) are written as a sentence with the
    // tab's site (17-notify.js, plainRequest); the tab's address comes asynchronously.
    if (!request.site && activeTab != null) {
      chrome.tabs.get(activeTab).then((tab) => {
        const plain = notify()?.plainRequest?.(request, tab?.url || tab?.pendingUrl || "");
        if (plain && plain !== request) { words(plain); layout(); }
      }, () => {});
    }
    if (request.closeDenies) card.append(el("div", "vm-site-note", "Vivaldi denies this if it closes: closing it, a click elsewhere or another tab."));
    card.addEventListener("pointerup", () => setTimeout(releaseFocus, 0)); // a press that never became a click leaves the cursor on the button too
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      const inBar = !!card.closest("#vm-cmd");
      dismiss(popup);
      if (inBar) document.querySelector("#vm-cmd input")?.focus(); // the cursor stays in the bar, not on the page's body
    });
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
    if (!notify()) return;
    const card = build(popup, request);
    moved();
    if (entry) { entry.card = card; entry.labels = labels; notify().add({ id: entry.id, tab: entry.tab, type: "permission", el: card }); return; }
    const id = `site-${++cardSeq}`;
    const entryNew = { card, labels, tab: activeTab, id };
    cards.set(popup, entryNew);
    dismissed.delete(activeTab);
    notify().add({ id, tab: activeTab, type: "permission", el: card });
    giveBackFocus(popup);
    // In the moment of a tab switch Vivaldi's field can still show the tab left's popup: drawn then, the card would be filed
    // under the new tab and stay hidden on return (measured in the sandbox, fix round 1). Within a second of a switch the
    // card goes to whichever of the two tabs is on the site that asks.
    const prev = previousTab;
    if (prev != null && prev !== activeTab && Date.now() - switchedAt < 1000 && request.site) {
      const hostOf = (url) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host; } catch (_) { return ""; } };
      const site = hostOf(request.site);
      Promise.all([chrome.tabs.get(entryNew.tab).catch(() => null), chrome.tabs.get(prev).catch(() => null)]).then(([now, before]) => {
        if (cards.get(popup) !== entryNew || !before) return;
        if (site && hostOf(now?.url || now?.pendingUrl || "") !== site && hostOf(before.url || before.pendingUrl || "") === site) {
          entryNew.tab = prev;
          notify()?.add({ id, tab: prev, type: "permission", el: card });
        }
      }, () => {});
    }
  };

  // `byPopup`: the popup went away by itself, not by the user's answer or dismissal on the card: the question is owed back.
  const drop = (popup, byPopup = true) => {
    const entry = cards.get(popup);
    if (!entry) return;
    notify()?.remove(entry.id);
    entry.card.remove();
    cards.delete(popup);
    moved();
    if (byPopup && !acted.has(popup) && entry.tab != null) {
      owed.add(entry.tab);
      if (entry.tab === activeTab) reopen(entry.tab, 60, false, barOpen());
    }
  };

  // The pill: the question is still pending (the user closed its card, or it could not be brought back) and the field that
  // holds Vivaldi's icon is collapsed, so this is the way back. Shown for the active tab only, while its icon is there.
  const syncPill = () => {
    try {
      const tab = activeTab;
      if (tab != null && dismissed.has(tab) && !document.querySelector(ICON_ANY)) dismissed.delete(tab); // the request is over
      const want = tab != null && dismissed.has(tab) && !cards.size && !!document.querySelector(ICON) && !!notify();
      if (want && !pill?.isConnected) {
        pill = el("button", "vm-site-pill", "Site request pending");
        pill.type = "button";
        pill.title = "Show the site's question";
        pill.addEventListener("click", (e) => {
          if (e.detail > 1 || recentMove()) return;
          dismissed.delete(activeTab);
          pill.remove();
          reopen(activeTab, 0, true);
        });
        moved();
        notify().add({ id: "site-pill", tab, type: "pending", el: pill });
      } else if (!want && pill) {
        moved();
        notify()?.remove("site-pill");
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
  // `force`: the user asked (the pill): it always opens, and does not count toward the automatic limit. Nothing re-opens
  // while one of Vivarc's own menus is open (the press that closed the popup may be the one that opened it): the pill
  // holds the question until the menu is gone. The Shield's popup holds it the same way, for as long as it stays open.
  // `bar`: the command bar is open on this tab: its fly-up is where the question shows, so the bar does not hold it.
  const reopen = async (tab, first = 150, force = false, bar = false) => {
    const token = ++reopenToken;
    try {
      let tries = 0;
      for (let i = 0; i < 80 && tries < 14; i++) {
        await wait(i === 0 ? first : 150);
        if (token !== reopenToken || activeTab !== tab) return;
        if (cards.size) { owed.delete(tab); return; }
        // The command bar never holds a question back: its fly-up shows it, and the reopened popup cannot take the bar's
        // cursor (it lives in Vivaldi's hidden field). Ctrl+L can close Vivaldi's popup just before the bar is up, so this
        // is decided at each try, not by whether the bar was open when the popup went.
        if (!force && menuOpen(false)) { dismissed.add(tab); syncPill(); if (shieldUp()) i--; continue; }
        tries++;
        const button = document.querySelector(ICON);
        if (!button) continue;
        owed.delete(tab);
        dismissed.delete(tab);
        const now = Date.now();
        const recent = (reopens.get(tab) || []).filter((t) => now - t < AUTO_REOPEN_MS);
        if (!force && recent.length >= AUTO_REOPEN_MAX) { dismissed.add(tab); syncPill(); return; }
        if (!force) reopens.set(tab, [...recent, now]);
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
      if (activeTab !== info.tabId) { previousTab = activeTab; switchedAt = Date.now(); }
      activeTab = info.tabId;
      if (owed.has(info.tabId)) reopen(info.tabId, 150, false, barOpen());
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
      if (t && t.nodeType === 1 && !t.closest?.(`${POPUP}, ${NOTE}`)) lastOutside = t;
    }, true);
    // Vivaldi closes the popup (the request stays pending) on a press anywhere outside it, and the card is outside it:
    // measured, a real click on the card's button closed the popup before the click could answer it. A press on the card
    // therefore goes no further than the card (window capture runs before Vivaldi's listeners). The same holds for the
    // command bar's input and fly-up (a press there would close the question the fly-up shows), but not its backdrop, whose
    // press closes the bar.
    for (const type of ["pointerdown", "mousedown", "touchstart"]) {
      window.addEventListener(type, (e) => { if (e.target?.closest?.(STOP)) e.stopImmediatePropagation(); }, true);
    }
    // The command bar opening on a tab with a question left pending (closed, or not brought back yet): it comes back, so the
    // fly-up shows it with live buttons (once per opening, not counted toward the automatic re-opens). One the user had
    // closed goes back to its pill when the bar closes unanswered: the bar showing it is not the user taking back the close.
    const closedBeforeBar = new Set();
    window.addEventListener("vm-command-bar", (e) => {
      try {
        if (!e.detail?.open) {
          for (const tab of closedBeforeBar) {
            for (const [popup, entry] of cards) if (entry.tab === tab && !acted.has(popup)) { stackMovedAt = 0; dismiss(popup); }
          }
          closedBeforeBar.clear();
          return;
        }
        if (cards.size || activeTab == null || !document.querySelector(ICON)) return;
        if (dismissed.has(activeTab)) closedBeforeBar.add(activeTab);
        dismissed.delete(activeTab);
        syncPill();
        reopen(activeTab, 0, true, true);
      } catch (error) { warn("bar", error); }
    });
    // The Shield's popup opens on the click, but Vivaldi closes the question's popup on the press: a press on the Shield
    // counts as busy at once, so the question does not come back while the button is held (and spend an automatic reopen).
    window.addEventListener("pointerdown", (e) => { if (e.target?.closest?.(".vm-dia-shield")) { shieldHeld = true; busyAt = Date.now(); } }, true);
    for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, () => { if (shieldHeld) { shieldHeld = false; busyAt = Date.now(); } }, true);
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    // For the sandbox's diagnostics: what this window holds (read only).
    window.__vm.siteRequestsState = () => ({ activeTab, cards: [...cards.values()].map((e) => ({ tab: e.tab, id: e.id, connected: e.card.isConnected })), owed: [...owed], dismissed: [...dismissed] });
    console.log("[vivarc] site requests started");
  } catch (error) {
    warn("start", error);
  }
})();
