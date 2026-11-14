// Back closes a tab a link opened, like Arc (KASOGIT/vivarc issue #164, open PR #168; an option in Vivarc Settings, off by
// default: Byron, 2026-11-14). In a tab that a link in another tab opened (its opener), with no back history of its own,
// Back closes the tab and the opener comes back on screen. It only acts on a Back that does nothing today: Vivaldi does
// nothing on Back with no history. Each way of pressing Back is caught on its own, since that Back fires no event:
// Vivaldi's Back keys (Alt+Left on Windows, Cmd+Left on a Mac, as bound in its key table), the mouse's Back button and
// the toolbar's Back button (greyed out then). PR #168's swipe detection is left out, as its upstream review asked.
// The opener is remembered from the link (webNavigation.onCreatedNavigationTarget), in memory only, so not across a restart.
(() => {
  // The decision, pure for the tests. tab: the tab Back was pressed on (the one on screen); opener: the tab its link was
  // in, if it is still open; canGoBack: read before Vivaldi acts on the same Back (null when not known: nothing closes);
  // shown: the space this window shows (Vivaldi's record); kept: a pin's or favorite's tab, or a split view's.
  // Only within one window and the space on screen: activating an opener parked in another space would break the record
  // (G1), and one in another window is not where the user is.
  const of = (tab) => {
    try { return Number(JSON.parse(tab?.vivExtData || "{}").workspaceId) || 0; } catch (_) { return 0; }
  };
  // openerKept: the opener is Peek's preview tab, not a page the user was on.
  const shouldClose = ({ on, tab, opener, canGoBack, shown, kept, openerKept = false }) => !!on && !!tab && !!opener && canGoBack === false && !kept && !openerKept &&
    !!tab.active && !tab.pinned && opener.id !== tab.id && opener.windowId === tab.windowId &&
    of(tab) === (shown || 0) && of(opener) === (shown || 0);

  // Vivaldi's Back keys, from its COMMAND_PAGE_BACK shortcuts, normalised as 00-core.js does: chords only (Backspace and
  // Z are Back too while Vivaldi's single-key shortcuts are on, but they are also typing). Vivaldi's defaults when the
  // table cannot be read.
  const norm = (combo) => String(combo).toLowerCase().split("+").map((s) => s.trim()).sort().join("+");
  const DEFAULT_KEYS = { windows: ["alt+left"], mac: ["meta+left"] };
  const backKeys = (shortcuts, windows) => [...new Set((Array.isArray(shortcuts) ? shortcuts : DEFAULT_KEYS[windows ? "windows" : "mac"])
    .filter((s) => typeof s === "string" && s.includes("+")).map(norm))];
  // A Back key that also moves the caret in a text field (Cmd+Left on a Mac): never acted on unless the page says its
  // cursor is not in one.
  const caretKey = (key, windows) => !windows && /(^|\+)(left|right)(\+|$)/.test(key) && key.includes("meta");

  // A click counts as a press of the greyed-out Back only when it is real (isTrusted) and landed on the Back button's own
  // toolbar slot: with the button let through (pointer-events: none), the click lands on the slot behind it. A click on
  // anything over it (a menu, the command bar's backdrop, the Ctrl+Tab row, a dialog) is that thing's.
  // trusted: e.isTrusted; onSlot: the click's target is inside the Back button's slot; disabled: the button is greyed out.
  const backClick = ({ on, trusted, onSlot, disabled }) => !!on && !!trusted && !!onSlot && !!disabled;
  window.__vm.back = { shouldClose, backKeys, caretKey, backClick, of };
  if (!window.__vm.store || !globalThis.chrome?.tabs) return;

  const { settings } = window.__vm;
  const on = () => !!settings?.get?.("backCloses");
  const openers = new Map(); // tab id -> the id of the tab whose link opened it
  try {
    chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
      if (sourceTabId != null && tabId != null && sourceTabId !== tabId) openers.set(tabId, sourceTabId);
    });
  } catch (error) { console.warn("[vivarc] back closes: no link openers", error); }
  chrome.tabs.onRemoved.addListener((id) => openers.delete(id));
  chrome.tabs.onReplaced?.addListener((added, removed) => {
    if (openers.has(removed)) { openers.set(added, openers.get(removed)); openers.delete(removed); }
  });

  let myWindowId = null;
  chrome.windows.getCurrent().then((w) => { myWindowId = w.id; }, () => {});
  const webviewOf = (id) => document.querySelector(`webview[tab_id="${id}"]`);
  // Read at once, in the same turn as the press: once Vivaldi's own Back commits the webview reads false at its first
  // page, and the tab that just went back would close.
  const canGoBack = (id) => {
    const view = webviewOf(id);
    try { return typeof view?.canGoBack === "function" ? !!view.canGoBack() : null; } catch (_) { return null; }
  };
  // Kept: a pin's or favorite's tab, a split view's, and Peek's preview (window.__vm.peek where the module is loaded).
  const kept = (tab) => window.__vm.pins?.pinOf?.(tab) !== undefined || !!window.__vm.tilingOf?.(tab) || !!window.__vm.peek?.isPeekTab?.(tab);
  const closing = new Set();
  const last = { at: 0, how: null, closed: null, why: null };
  window.__vm.back.last = last;

  // `how`: which Back it was (for the log and the tests); history: canGoBack read at the press; check(tab): a last look
  // (the keys ask the page whether its cursor is in a text field).
  // `only`: the tab Back was pressed in, when the press names one (the mouse's message): nothing else closes.
  const tryClose = async (how, history, check, only = null) => {
    Object.assign(last, { at: Date.now(), how, closed: null, why: null });
    if (!on()) { last.why = "off"; return; }
    try {
      const windowId = myWindowId ?? (await chrome.windows.getCurrent()).id;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (only != null && tab?.id !== only) { last.why = "not the tab on screen"; return; }
      if (!tab || closing.has(tab.id)) { last.why = "no tab"; return; }
      const openerId = openers.get(tab.id);
      const opener = openerId != null ? await chrome.tabs.get(openerId).catch(() => null) : null;
      const shown = window.__vm.native?.record()?.activeIn(windowId) ?? of(tab);
      const at = history.has(tab.id) ? history.get(tab.id) : null;
      if (!shouldClose({ on: true, tab, opener, canGoBack: at, shown, kept: kept(tab), openerKept: !!opener && !!window.__vm.peek?.isPeekTab?.(opener) })) {
        last.why = !opener ? "not opened by a link here" : at !== false ? "it has history" : "not eligible";
        return;
      }
      if (check && !(await check(tab))) { last.why = "typing"; return; }
      closing.add(tab.id);
      try {
        await chrome.tabs.update(opener.id, { active: true });
        await chrome.tabs.remove(tab.id);
        last.closed = tab.id;
      } finally { closing.delete(tab.id); }
    } catch (error) {
      last.why = `error: ${error?.message || error}`;
      console.warn("[vivarc] back closes:", error);
    }
  };
  // Every remembered tab's history is read before the first await, for the reason given at canGoBack (a caller that has
  // to wait before it knows whether to act takes the reading first and hands it over).
  const readHistory = () => new Map([...openers.keys()].map((id) => [id, canGoBack(id)]));
  const onBack = (how, check, history = readHistory(), only = null) => {
    if (!on()) { Object.assign(last, { at: Date.now(), how, closed: null, why: "off" }); return; }
    tryClose(how, history, check, only);
  };

  // The page's own answer to "is the cursor in a text field" (a key that is Back for Vivaldi also moves the caret there).
  // null when the page cannot be asked (an internal page).
  // Into open shadow roots; an iframe that has the cursor answers "iframe" (its own field cannot be read from here).
  const EDITING = `(() => { let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (a && /^(IFRAME|FRAME)$/.test(a.tagName)) return "iframe";
    return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); })()`;
  const pageEditing = (tab) => new Promise((resolve) => {
    const view = webviewOf(tab.id);
    if (!view?.executeScript) return resolve(null);
    try {
      view.executeScript({ code: EDITING }, (result) => resolve(chrome.runtime.lastError ? null : result?.[0] === "iframe" ? "iframe" : result?.[0] === true));
    } catch (_) { resolve(null); }
  });
  const uiEditing = () => {
    const a = document.activeElement;
    return !!a && a.tagName !== "WEBVIEW" && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };

  // Vivaldi's Back keys, as bound now in its table (read again when the table changes).
  let keys = backKeys(null, window.__vm.windows);
  const readKeys = () => Promise.resolve(vivaldi.prefs.get("vivaldi.actions")).then((pref) => {
    const shortcuts = pref?.value?.[0]?.COMMAND_PAGE_BACK?.shortcuts;
    if (Array.isArray(shortcuts)) keys = backKeys(shortcuts, window.__vm.windows);
  }).catch(() => {});
  readKeys();
  try { vivaldi.prefs.onChanged?.addListener((change) => { if ((typeof change === "string" ? change : change?.path) === "vivaldi.actions") readKeys(); }); } catch (_) {}
  const here = (pressedIn, focused) => {
    const shared = window.__vm.sidebarHide?.pressedHere;
    const own = window.vivaldiWindowId;
    if (shared) return shared(pressedIn, own, focused);
    return typeof pressedIn === "number" && typeof own === "number" ? pressedIn === own : !!focused;
  };
  window.__vm.onShortcut((key, _combo, pressedIn) => {
    if (!keys.includes(key) || !on()) return;
    const history = readHistory(); // now, in the press's own turn, even when the window check below has to wait
    const act = (focused) => {
      if (!here(pressedIn, focused)) return;
      if (uiEditing()) return;
      const caret = caretKey(key, window.__vm.windows);
      onBack("key", async (tab) => {
        const editing = await pageEditing(tab);
        // an iframe with the cursor may hold a text field: a caret key (Cmd+Left on a Mac) is left to it
        if (editing === "iframe") return !caret;
        return editing === false || (editing === null && !caret);
      }, history);
    };
    if (typeof pressedIn === "number" && typeof window.vivaldiWindowId === "number") act(false);
    else chrome.windows.getCurrent().then((win) => act(win.focused), () => {});
  });

  // The toolbar's Back, greyed out when there is no history: a disabled button gets no click, so while the option is on
  // vivarc.css lets clicks on it through (pointer-events: none) and the click is found here by where it landed.
  const disabledBack = (el) => el.matches?.(":disabled") || !!el.querySelector?.("button:disabled");
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || !on()) return;
    const hit = [...document.querySelectorAll('[data-name="Back"]')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (!hit) return;
    const slot = hit.closest(".button-toolbar") || hit.parentElement;
    const onSlot = !!slot && e.target instanceof Node && (slot === e.target || slot.contains(e.target));
    if (!backClick({ on: true, trusted: e.isTrusted, onSlot, disabled: disabledBack(hit) })) return;
    onBack("button");
  }, true);

  // The mouse's Back button reaches only the page (measured on 8.3: the page gets mousedown, mouseup and auxclick with
  // button 3, and Vivaldi's UI hears nothing). So while the option is on, a tab a link opened gets a small listener in its
  // page (webview.executeScript, an isolated world: the page cannot see or call it) that says so when the Back button is
  // released on a page with no history (navigation.canGoBack false). Every window's UI hears the message; the one
  // holding the tab acts. Nothing is put into a page while the option is off.
  const MOUSE_SCRIPT = `(() => {
    if (window.__vivarcBackMouse) return;
    window.__vivarcBackMouse = true;
    addEventListener("mouseup", (e) => {
      if (e.isTrusted && e.button === 3 && window.navigation && navigation.canGoBack === false) chrome.runtime.sendMessage({ vivarcBack: "mouse" });
    }, true);
  })();`;
  const listen = (tabId) => {
    if (!on() || !openers.has(tabId)) return;
    try { webviewOf(tabId)?.executeScript?.({ code: MOUSE_SCRIPT, runAt: "document_start" }, () => void chrome.runtime.lastError); } catch (_) {}
  };
  try {
    chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => { if (frameId === 0) listen(tabId); });
  } catch (_) {}
  // A tab opened in the background may have no webview here until it is shown: it gets the listener then.
  chrome.tabs.onActivated.addListener(({ tabId }) => setTimeout(() => listen(tabId), 50));
  // Switched on while tabs a link opened are already open: they get the listener now.
  settings?.onChange?.(() => { if (on()) for (const id of openers.keys()) listen(id); });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.vivarcBack !== "mouse" || !sender?.tab || sender.frameId) return;
    if (myWindowId == null || sender.tab.windowId !== myWindowId) return;
    onBack("mouse", undefined, readHistory(), sender.tab.id);
  });

  window.__vm.back.onBack = onBack;
  window.__vm.back.openers = () => [...openers];
})();
