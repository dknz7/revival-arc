// Vivarc's notifications (Task 9b): one place for everything Vivarc or Vivaldi has to tell the user about a page, since
// Vivaldi's own address field, where it shows most of it, is never shown (the command bar takes its place).
//
// - Toasts drop down from just under the breadcrumb (Dia layout, from the crumb's left edge) or the URL bar at the top of
//   the sidebar (Arc layout); with neither on screen, from the top left of the sidebar or the page. Up to three show as
//   rows; a fourth folds them into one stack that opens on a click. A site's question (16-site-requests.js), a Vivarc
//   message (30-toast.js: the tear-off's Undo, "Copied link"...), a blocked pop-up, a zoom change, Ctrl+D's bookmark.
// - With the command bar open (20-command-bar.js), nothing shows as a toast: everything for the bar's tab goes into a
//   fly-up right above its input, questions first, then messages, then indicators (rows) and the page's own actions.
// - Vivaldi's own popups of the hidden field (a device chooser, the decided-permission panel, blocked pop-ups, translate,
//   bookmark editor, install app...) drop from the same place (vivarc.css, --vm-drop-x/y set here).
// - Notifications belong to their tab: another tab's hide and come back on return. Messages of Vivarc's own (no tab) show
//   on every tab.
// Measured on Vivaldi 8.3 (task 8x, 9b): the field's buttons other than the site info are display:none in a side tab bar,
// so their popups open invisibly unless Vivarc shows them; a synthetic press opens them.
(() => {
  // ---- pure (tests/test_notify.py) ----
  // Where each kind goes, with the bar closed and open. "toast": the stack; "fly": the fly-up (also a toast's place while the
  // bar is open); "row": a fly-up row only, never on its own; "vivaldi": Vivaldi's own UI, placed by Vivarc at most; "none".
  const SURFACES = {
    permission: ["toast", "fly"], // a site's question: notifications, location, camera, mic, clipboard, MIDI, downloads, storage, protocol, windows, fonts
    pending: ["toast", "fly"], // the pill of a question the user closed
    popupBlocked: ["toast", "fly"], // then a row while the icon stays
    zoom: ["toast", "fly"], // then a row while not 100 %
    bookmarked: ["toast", "fly"],
    message: ["toast", "fly"], // Vivarc's own messages (30-toast.js), the tear-off's Undo among them
    decided: ["none", "row"], // a decided permission, blocked content, mixed content: indicators
    security: ["none", "row"],
    translate: ["none", "row"],
    siteInfo: ["none", "row"], reader: ["none", "row"], feeds: ["none", "row"], install: ["none", "row"], qr: ["none", "row"],
    device: ["vivaldi", "vivaldi"], // Vivaldi's chooser, dropped from the anchor
    download: ["vivaldi", "vivaldi"], find: ["vivaldi", "vivaldi"], dialog: ["vivaldi", "vivaldi"], fullscreen: ["vivaldi", "vivaldi"],
    cast: ["vivaldi", "vivaldi"], extension: ["vivaldi", "vivaldi"],
    password: ["none", "none"], // out of scope (Byron: 1Password, Vivaldi's saving off)
  };
  const surfaceOf = (type, barOpen) => (SURFACES[type] || ["none", "none"])[barOpen ? 1 : 0];
  const isQuestion = (note) => note.type === "permission" || note.type === "pending";
  const ownedBy = (note, tab) => note.tab == null || note.tab === tab;
  // Questions first (oldest first, the order they were asked), then the rest by age.
  const ordered = (notes) => [...notes].sort((a, b) => (isQuestion(b) - isQuestion(a)) || (a.at - b.at));
  // The toasts to show: none while the bar is open (they are in the fly-up), else the tab's own and Vivarc's.
  const toastsFor = (notes, tab, barOpen) => barOpen ? [] : ordered(notes.filter((n) => ownedBy(n, tab) && surfaceOf(n.type, false) === "toast"));
  // The fly-up's notes for the bar's tab: questions, then messages (indicator rows are built by the fly-up itself).
  const flyFor = (notes, tab) => ordered(notes.filter((n) => ownedBy(n, tab) && surfaceOf(n.type, true) === "fly"));
  // Three or fewer: rows. Four or more: one stack (the first of them on top, a question if there is one), unless opened.
  const STACK_AT = 4;
  const stackPlan = (count, expanded) => count < STACK_AT ? { mode: "rows", shown: count, hidden: 0 }
    : expanded ? { mode: "open", shown: count, hidden: 0 } : { mode: "stack", shown: 1, hidden: count - 1 };
  // Buttons go on the right of the message when they fit: at most two, short ("Allow", "Deny", "Reset", "Undo"), and a
  // message short enough to keep a line or two beside them. Otherwise under the message.
  const buttonsFit = (labels, message = "") => labels.length <= 2 && labels.join("").length <= 14 && String(message).length <= 70;

  // Vivaldi shows some questions with its raw permission name and no site ("window-placement", "local-fonts"; measured on
  // 8.3, task 8x): written as a sentence, the site taken from the tab.
  const JARGON = {
    "window-placement": "wants to see your screens, to place its windows on them",
    "window-management": "wants to see your screens, to place its windows on them",
    "local-fonts": "wants to use the fonts installed on this computer",
    "idle-detection": "wants to know when you are away from this device",
    "keyboard-lock": "wants to take over your keyboard shortcuts",
    "pointer-lock": "wants to lock your mouse pointer",
    "file-system": "wants to edit files on this computer",
    "protected-media-identifier": "wants to play protected content",
    "captured-surface-control": "wants to scroll and zoom the tab you share",
    "screen-wake-lock": "wants to keep the screen awake",
    "storage-access": "wants to use cookies and site data from another site",
    "top-level-storage-access": "wants to use cookies and site data from another site",
    "vr": "wants to use your virtual reality device",
    "ar": "wants to use augmented reality",
    "hand-tracking": "wants to track your hands",
    "web-app-installation": "wants to install a web app",
  };
  const RAW = /^[a-z]+(?:[-_][a-z]+)*$/;
  const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch (_) { return ""; } };
  // -> the request with readable words (prefix, site, ask); `raw` marks one Vivarc wrote.
  const plainRequest = (request, url) => {
    if (!request) return request;
    const word = String(request.ask || "").trim().replace(/[.?!]$/, "").toLowerCase();
    if (request.site || !RAW.test(word)) return request;
    const site = originOf(url) || "This site";
    const ask = JARGON[word] || `wants to use ${word.replace(/[-_]/g, " ")}`;
    return { ...request, prefix: originOf(url) ? "" : request.prefix, site, ask: `${ask}.`, raw: word };
  };

  // Where a toast drops from, by what is on screen (rects as {left, top, right, bottom, width, height}, or null):
  // the breadcrumb's text (Dia), the sidebar's URL bar (Arc), the sidebar, else the page column.
  const GAP = 6;
  const dropPoint = ({ crumb, url, panel, page, winW }, width = 360) => {
    const shown = (r) => r && r.width > 0 && r.height > 0;
    let x, y, w = width;
    if (shown(crumb)) { x = crumb.left; y = crumb.bottom + GAP; }
    else if (shown(url)) { x = url.left; y = url.bottom + GAP; w = Math.max(300, Math.min(width, url.width)); }
    else if (shown(panel)) { x = panel.left + 8; y = panel.top + 8; }
    else if (shown(page)) { x = page.left + 12; y = page.top + 12; }
    else { x = 12; y = 12; }
    if (winW) x = Math.max(8, Math.min(x, winW - w - 8));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w) };
  };

  window.__vm.notifyLogic = { SURFACES, surfaceOf, ownedBy, ordered, toastsFor, flyFor, stackPlan, STACK_AT, buttonsFit, plainRequest, JARGON, dropPoint };
  if (!window.__vm.store || typeof document === "undefined") return;

  // ---- the stack and the fly-up ----
  const warn = (what, error) => console.warn(`[vivarc] notify ${what}:`, error);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const notes = new Map(); // id -> { id, tab, type, el, at, timer }
  let host = null;
  let expanded = false;
  let activeTab = null;
  let myWindow = null;
  let bar = null; // { fly, tab: () => id, close: () => void } while the command bar is open

  const hostEl = () => {
    if (host?.isConnected) return host;
    const browser = document.querySelector("#browser");
    if (!browser) return null;
    host = el("div");
    host.id = "vm-notify";
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "Notifications");
    host.setAttribute("aria-live", "polite");
    browser.append(host);
    return host;
  };

  // A note of the usual shape: an icon, the message, buttons (right of it when they fit, else under it), a close button.
  // `actions`: [{ label, run }]; a click runs it and, unless it returns false, the note goes. `close`: false for none, or
  // { label, title } to name what closing does.
  const build = ({ icon, text, actions = [], close = {}, cls = "" }) => {
    const card = el("div", `vm-note ${cls}`.trim());
    card.setAttribute("role", "group");
    const head = el("div", "vm-note-head");
    card.append(head);
    if (icon) { const i = el("span", "vm-note-icon"); i.innerHTML = icon; head.append(i); }
    const body = el("div", "vm-note-text");
    if (text instanceof Node) body.append(text); else body.textContent = text || "";
    head.append(body);
    const row = el("div", "vm-note-actions");
    for (const action of actions) {
      const b = el("button", "vm-note-btn", action.label);
      b.type = "button";
      if (action.cls) b.classList.add(action.cls);
      row.append(b);
    }
    const inline = buttonsFit(actions.map((a) => a.label), body.textContent);
    card.classList.toggle("vm-note-inline", inline && actions.length > 0);
    if (actions.length) (inline ? head : card).append(row);
    if (close !== false) {
      const x = el("button", "vm-note-x", close.label || "×");
      x.type = "button";
      x.title = close.title || "Dismiss";
      x.setAttribute("aria-label", close.title || "Dismiss");
      head.append(x);
    }
    return card;
  };

  // add({ id, tab, type, el } | { id, tab, type, icon, text, actions, close, ms }): a note with that id is replaced.
  const add = (spec) => {
    try {
      const old = notes.get(spec.id);
      if (old) { clearTimeout(old.timer); if (old.el !== spec.el) old.el.remove(); }
      const card = spec.el || build(spec);
      const note = { id: spec.id, tab: spec.tab ?? null, type: spec.type || "message", el: card, at: old?.at ?? Date.now(), onClose: spec.onClose };
      if (old && spec.fresh) note.at = Date.now();
      card.dataset.vmNote = spec.id;
      card.classList.add("vm-note-item");
      if (!spec.el) {
        card.querySelectorAll(".vm-note-btn").forEach((b, i) => b.addEventListener("click", (e) => {
          if (e.detail > 1) return;
          let keep = false;
          try { keep = spec.actions[i].run() === false; } catch (error) { warn("action", error); }
          if (!keep) remove(spec.id);
        }));
        card.querySelector(".vm-note-x")?.addEventListener("click", (e) => {
          if (e.detail > 1) return;
          try { spec.onClose?.(); } catch (error) { warn("close", error); }
          remove(spec.id);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key !== "Escape" || spec.close === false) return;
          e.preventDefault(); e.stopPropagation();
          try { spec.onClose?.(); } catch (error) { warn("close", error); }
          remove(spec.id);
        });
      }
      if (spec.ms) note.timer = setTimeout(() => remove(spec.id), spec.ms);
      notes.set(spec.id, note);
      render();
      return note;
    } catch (error) { warn("add", error); return null; }
  };
  const remove = (id) => {
    const note = notes.get(id);
    if (!note) return;
    clearTimeout(note.timer);
    notes.delete(id);
    note.el.remove();
    render();
  };

  // ---- where toasts and Vivaldi's field popups drop from ----
  const rectOf = (node) => {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden" ? r : null;
  };
  let drop = { x: 12, y: 12, w: 360 };
  const place = () => {
    try {
      const browser = document.querySelector("#browser");
      if (!browser) return;
      const dia = browser.classList.contains("vm-dia") && !browser.classList.contains("address-top-off");
      const crumb = dia ? rectOf(document.querySelector("#vm-dia-crumb .vm-dia-text")) || rectOf(document.querySelector("#vm-dia-crumb")) : null;
      const hidden = browser.classList.contains("vm-sidebar-hidden");
      const url = !dia && !hidden ? rectOf(document.querySelector("#vm-panel .vm-current-url")) : null;
      const panel = !hidden ? rectOf(document.querySelector("#vm-panel")) : null;
      drop = dropPoint({ crumb, url, panel, page: rectOf(document.querySelector("#webview-container")), winW: window.innerWidth });
      for (const [name, value] of [["--vm-drop-x", drop.x], ["--vm-drop-y", drop.y], ["--vm-drop-w", drop.w]]) {
        if (browser.style.getPropertyValue(name) !== `${value}px`) browser.style.setProperty(name, `${value}px`);
      }
    } catch (error) { warn("place", error); }
  };

  // ---- rendering ----
  const MORE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  let moreEl = null;
  const moreButton = () => {
    if (!moreEl) {
      moreEl = el("button", "vm-note-more");
      moreEl.type = "button";
      moreEl.addEventListener("click", (e) => { if (e.detail > 1) return; expanded = !expanded; render(); });
    }
    return moreEl;
  };
  const render = () => {
    try {
      const list = [...notes.values()];
      const container = hostEl();
      if (!container) return;
      place();
      if (bar) { renderFly(); container.replaceChildren(); container.hidden = true; return; }
      container.hidden = false;
      const shown = toastsFor(list, activeTab, false);
      if (shown.length < STACK_AT) expanded = false;
      const plan = stackPlan(shown.length, expanded);
      const children = plan.mode === "stack" ? [shown[0]] : shown; // the first (a question, if any) on top of the stack
      const nodes = children.map((n) => n.el);
      container.classList.toggle("vm-notify-stacked", plan.mode === "stack");
      if (plan.mode !== "rows") {
        const more = moreButton();
        const label = plan.mode === "stack" ? `${shown.length} notifications · Show all` : "Show less";
        if (more.firstChild?.textContent !== label) {
          const chev = el("span", "vm-note-chev");
          chev.innerHTML = MORE_SVG;
          more.replaceChildren(el("span", null, label), chev);
          more.setAttribute("aria-expanded", String(plan.mode === "open"));
        }
        nodes.push(more);
      }
      // Kept in place when nothing changed: a re-append would restart the drop-in animation and move the focus.
      const same = container.children.length === nodes.length && nodes.every((n, i) => container.children[i] === n);
      if (!same) container.replaceChildren(...nodes);
    } catch (error) { warn("render", error); }
  };

  // The fly-up: the bar's tab's questions and messages (the note elements themselves move in, so a question's buttons keep
  // answering Vivaldi's popup), then rows built from the page's state, then the page's actions.
  const rowSources = [];
  const renderFly = () => {
    try {
      if (!bar?.fly?.isConnected) return;
      const page = bar.tab();
      const tab = page ?? activeTab;
      const items = flyFor([...notes.values()], tab).map((n) => n.el);
      // The page's own rows (its state and actions) only when the bar edits that page (Ctrl+L, the crumb, the URL bar), not
      // over a new tab or a private window's introduction page.
      const rows = [];
      if (page != null) for (const source of rowSources) { try { rows.push(...(source(tab, bar) || [])); } catch (error) { warn("row", error); } }
      const nodes = [...items, ...rows];
      const same = bar.fly.children.length === nodes.length && nodes.every((n, i) => bar.fly.children[i] === n);
      if (!same) bar.fly.replaceChildren(...nodes);
      bar.fly.hidden = !nodes.length;
    } catch (error) { warn("fly-up", error); }
  };
  // Rows are rebuilt on each render; their builders cache by key so an unchanged row keeps its element.
  const rowCache = new Map();
  const row = (key, { icon, text, actions = [], cls = "" }) => {
    const sig = JSON.stringify([text, actions.map((a) => a.label), cls]);
    const hit = rowCache.get(key);
    if (hit && hit.sig === sig) { hit.actions = actions; return hit.el; }
    const r = el("div", `vm-fly-row ${cls}`.trim());
    if (icon) { const i = el("span", "vm-note-icon"); if (icon instanceof Node) i.append(icon); else i.innerHTML = icon; r.append(i); }
    r.append(el("span", "vm-fly-text", text));
    const entry = { el: r, sig, actions };
    actions.forEach((a, i) => {
      const b = el("button", "vm-note-btn", a.label);
      b.type = "button";
      b.addEventListener("click", (e) => { if (e.detail > 1) return; try { entry.actions[i]?.run(); } catch (error) { warn("row action", error); } });
      r.append(b);
    });
    rowCache.set(key, entry);
    return r;
  };

  // ---- the command bar (20-command-bar.js) ----
  const barOpened = (spec) => { bar = spec; render(); };
  const barClosed = () => {
    if (!bar) return;
    // The notes go back to the stack before the bar's DOM goes (they would leave with it).
    const fly = bar.fly;
    bar = null;
    for (const n of notes.values()) if (fly?.contains(n.el)) n.el.remove();
    render();
  };
  const closeBar = () => { try { bar?.close?.(); } catch (error) { warn("close bar", error); } };

  // ---- Vivaldi's field buttons: pressed from a row or a toast ----
  const FIELD = "#tabs-tabbar-container .UrlBar-AddressField";
  const fieldButtons = () => [...document.querySelectorAll(`${FIELD} .toolbar-insideinput > .button-toolbar, ${FIELD} .toolbar .button-toolbar`)];
  const labelOf = (b) => (b.querySelector("button")?.getAttribute("aria-label") || b.title || b.querySelector("button")?.title || "").split("\n")[0].trim();
  const pressOf = (b) => b?.querySelector("button.ToolbarButton-Button, button") || null;
  // Opens a field button's own popup where toasts drop from (vivarc.css), the command bar closed first so the popup's focus
  // and Vivaldi's outside-press closer do not meet the bar.
  const openFieldButton = (b) => {
    closeBar();
    setTimeout(() => {
      try {
        place();
        const target = pressOf(b?.isConnected ? b : null);
        if (target) window.__vm.press(target);
      } catch (error) { warn("press", error); }
    }, 30);
  };
  // Drives a field button's popup without showing it (vm-quiet-pop hides field popups): `act(popup)` then Escape.
  let quiet = 0;
  const quietly = async (button, act) => {
    const browser = document.querySelector("#browser");
    const target = pressOf(button);
    if (!browser || !target) return false;
    quiet++;
    browser.classList.add("vm-quiet-pop");
    try {
      window.__vm.press(target);
      let popup = null;
      for (let i = 0; i < 20 && !popup; i++) {
        await new Promise((r) => setTimeout(r, 50));
        popup = button.querySelector(".button-popup, .addressfield-popup-container");
      }
      if (!popup) return false;
      await act(popup);
      await new Promise((r) => setTimeout(r, 50));
      if (popup.isConnected) popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
      return true;
    } finally {
      setTimeout(() => { if (--quiet <= 0) { quiet = 0; browser.classList.remove("vm-quiet-pop"); } }, 120);
    }
  };

  // ---- the fly-up's rows: the page's state (indicators) and the page's actions ----
  const SVG = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const ICONS = {
    info: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    lock: SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    warn: SVG('<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4M12 17h.01"/>'),
    zoom: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4M8.5 11h5M11 8.5v5"/>'),
    star: SVG('<path d="m12 4 2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6 9.6 9Z"/>'),
    popup: SVG('<rect x="3" y="6" width="13" height="13" rx="2"/><path d="M14 3h7v7M21 3l-9 9"/>'),
    shield: SVG('<path d="M12 3.5 19 6v5.6c0 4.4-2.9 7.9-7 9.9-4.1-2-7-5.5-7-9.9V6Z"/>'),
  };
  const zoomOf = new Map(); // tab -> zoom factor, kept from onZoomChange and getZoom
  const pct = (z) => `${Math.round(z * 100)}%`;
  const isPopupBlocker = (b) => b.matches(".permission-popup.is-blocking") && /pop-?up/i.test(labelOf(b));
  rowSources.push((tab) => {
    const out = [];
    // Indicators: the field's permission icons (a decided permission, blocked pop-ups, blocked content), in Vivaldi's words.
    const buttons = fieldButtons();
    buttons.filter((b) => b.matches(".permission-popup:not(.is-undecided)")).forEach((b, i) => {
      const text = labelOf(b) || "Site permission";
      out.push(row(`perm-${i}-${text}`, { icon: isPopupBlocker(b) ? ICONS.popup : ICONS.shield, text, cls: "vm-fly-indicator",
        actions: [{ label: isPopupBlocker(b) ? "Show" : "Change", run: () => openFieldButton(b) }] }));
    });
    // Connection security (the site-info button's state): a row when the page is not secure.
    const info = document.querySelector(`${FIELD} .SiteInfoButton`);
    const insecure = !!info?.matches(".warning, .insecure, .dangerous");
    if (insecure) {
      out.push(row("security", { icon: ICONS.warn, text: labelOf(info) || "Connection not secure", cls: "vm-fly-indicator",
        actions: [{ label: "Site info", run: () => siteInfo(info) }] }));
    }
    const z = zoomOf.get(tab);
    if (z && Math.abs(z - 1) > 0.001) {
      out.push(row("zoom", { icon: ICONS.zoom, text: `Zoom ${pct(z)}`, cls: "vm-fly-indicator",
        actions: [{ label: "Reset", run: () => { chrome.tabs.setZoom(tab, 0).catch(() => {}); } }] }));
    }
    // The page's own actions (Vivaldi's hidden field buttons, in its words): one row of chips.
    const actions = [];
    if (info && !insecure) actions.push({ label: "Site info", run: () => siteInfo(info) }); // the insecure row has it already
    for (const b of buttons) {
      if (b.matches(".permission-popup, .SiteInfoButton, .BookmarkButton-Button, .password-icon")) continue;
      const label = labelOf(b);
      if (label) actions.push({ label, run: () => openFieldButton(b) });
    }
    if (actions.length) {
      const sig = JSON.stringify(actions.map((a) => a.label));
      let chips = rowCache.get("chips");
      if (!chips || chips.sig !== sig) {
        const r = el("div", "vm-fly-chips");
        chips = { el: r, sig, actions };
        actions.forEach((a, i) => {
          const b = el("button", "vm-fly-chip", a.label);
          b.type = "button";
          b.addEventListener("click", (e) => { if (e.detail > 1) return; try { chips.actions[i]?.run(); } catch (error) { warn("chip", error); } });
          r.append(b);
        });
        rowCache.set("chips", chips);
      }
      chips.actions = actions;
      out.push(chips.el);
    }
    return out;
  });
  // Site info: the Dia layout's Shield (15-dia.js places Vivaldi's popup under it); otherwise Vivaldi's popup, dropped from
  // the anchor like the others.
  const siteInfo = (info) => {
    const shield = document.querySelector("#vm-dia-crumb .vm-dia-shield");
    if (shield && rectOf(shield)) { closeBar(); setTimeout(() => shield.click(), 30); return; }
    openFieldButton(info);
  };

  // ---- sources of toasts: zoom, Ctrl+D, a blocked pop-up ----
  const navigatedAt = new Map(); // tab -> last address change (a site's own zoom comes back on navigation: not the user's)
  let activatedAt = 0;
  const onZoom = async ({ tabId, oldZoomFactor, newZoomFactor }) => {
    try {
      zoomOf.set(tabId, newZoomFactor);
      if (tabId !== activeTab || Math.abs(oldZoomFactor - newZoomFactor) < 0.001) return;
      if ((await chrome.windows.getCurrent().catch(() => null))?.focused === false) return; // a site's zoom reaches other windows' tabs too
      if (Date.now() - activatedAt < 1000 || Date.now() - (navigatedAt.get(tabId) || 0) < 1500) return;
      if (Math.abs(newZoomFactor - 1) < 0.001) { remove(`zoom-${tabId}`); render(); return; }
      add({ id: `zoom-${tabId}`, tab: tabId, type: "zoom", icon: ICONS.zoom, text: `Zoom ${pct(newZoomFactor)}`, ms: 2500, fresh: true,
        actions: [{ label: "Reset", run: () => { chrome.tabs.setZoom(tabId, 0).catch(() => {}); } }] });
    } catch (error) { warn("zoom", error); }
  };
  let bookmarkKeyAt = 0;
  const onBookmark = async (_id, node) => {
    try {
      if (!node?.url || Date.now() - bookmarkKeyAt > 2500 || activeTab == null) return;
      const tab = await chrome.tabs.get(activeTab).catch(() => null);
      if (!tab || (tab.url !== node.url && tab.pendingUrl !== node.url)) return;
      bookmarkKeyAt = 0;
      add({ id: `bookmarked-${tab.id}`, tab: tab.id, type: "bookmarked", icon: ICONS.star, text: "Bookmarked", ms: 3500, fresh: true,
        actions: [{ label: "Edit", run: () => { const star = document.querySelector(`${FIELD} .BookmarkButton-Button`); if (star) openFieldButton(star); } }] });
    } catch (error) { warn("bookmark", error); }
  };
  // A blocked pop-up: Vivaldi adds its icon to the field (hidden). One toast per icon; Allow opens the blocked page(s)
  // through Vivaldi's own popup (its links), unseen.
  const blockedTabs = new Set(); // tabs whose blocked pop-up was told (until the tab navigates): Vivaldi renders the icon anew per visit
  const watchBlockers = () => {
    try {
      for (const b of fieldButtons()) {
        if (activeTab == null || blockedTabs.has(activeTab) || !isPopupBlocker(b)) continue;
        blockedTabs.add(activeTab);
        const tab = activeTab;
        add({ id: `popup-${tab}`, tab, type: "popupBlocked", icon: ICONS.popup, text: "Pop-up blocked", ms: 6000, fresh: true,
          actions: [{ label: "Allow", run: () => { allowPopups(b); } }] });
      }
    } catch (error) { warn("pop-up", error); }
  };
  // Allow: Vivaldi's own choice for the site (its popup's second radio, "Always Allow", so Vivaldi records it), and the
  // blocked page(s), listed as links in that popup, open in new tabs beside the page (a script click on Vivaldi's links
  // opens nothing: measured on 8.3).
  const allowPopups = (button) => {
    const tab = activeTab;
    return quietly(button, async (popup) => {
      const urls = [...popup.querySelectorAll("a[href]")].map((a) => a.href).filter((u) => /^https?:/i.test(u));
      const radios = [...popup.querySelectorAll("input[type=radio]")];
      if (radios.length === 2 && !radios[1].checked) radios[1].click();
      const opener = tab != null ? await chrome.tabs.get(tab).catch(() => null) : null;
      for (const [i, url] of urls.entries()) {
        await chrome.tabs.create({ url, active: i === urls.length - 1, ...(opener ? { windowId: opener.windowId, index: opener.index + 1 + i, openerTabId: opener.id } : {}) });
      }
    }).catch((error) => warn("allow pop-up", error));
  };

  // ---- events ----
  const onActivated = ({ tabId, windowId }) => {
    if (myWindow == null || windowId !== myWindow) return;
    activeTab = tabId;
    activatedAt = Date.now();
    chrome.tabs.getZoom?.(tabId).then((z) => { zoomOf.set(tabId, z); }, () => {});
    render();
  };
  const start = () => {
    chrome.windows.getCurrent().then((w) => {
      myWindow = w.id;
      return chrome.tabs.query({ active: true, windowId: w.id });
    }).then(([t]) => { if (activeTab == null && t) { activeTab = t.id; chrome.tabs.getZoom?.(t.id).then((z) => zoomOf.set(t.id, z), () => {}); } render(); }, () => {});
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved?.addListener((id) => {
      zoomOf.delete(id); navigatedAt.delete(id); blockedTabs.delete(id);
      for (const n of [...notes.values()]) if (n.tab === id) remove(n.id);
    });
    chrome.tabs.onUpdated?.addListener((id, change) => {
      if (change.url !== undefined) {
        navigatedAt.set(id, Date.now());
        // A new page: the old one's blocked pop-up and bookmark toasts are about it no more.
        for (const kind of ["popup", "bookmarked"]) if (notes.get(`${kind}-${id}`)) remove(`${kind}-${id}`);
        blockedTabs.delete(id);
      }
    });
    chrome.tabs.onZoomChange?.addListener(onZoom);
    chrome.bookmarks?.onCreated?.addListener(onBookmark);
    const BOOKMARK_KEY = window.__vm.normalise(window.__vm.shortcut("meta+d"));
    window.__vm.onShortcut((key, _combo, pressedIn) => {
      if (key !== BOOKMARK_KEY) return;
      const here = window.__vm.sidebarHide?.pressedHere ?? ((a, b, f) => f);
      if (here(pressedIn, window.vivaldiWindowId, document.hasFocus())) bookmarkKeyAt = Date.now();
    });
    window.addEventListener("resize", () => { place(); });
    window.__vm.onMark?.(() => place());
    window.__vm.sidebarHide?.onChange?.(() => setTimeout(place, 0));
    window.__vm.settings?.onChange?.(() => setTimeout(place, 50));
    // The field's buttons change with the page (a blocked pop-up's icon); the anchors move with the layout. A light watch.
    let queued = 0;
    new MutationObserver(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; watchBlockers(); if (bar) renderFly(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => { if (notes.size || document.querySelector(`${FIELD} :is(.button-popup, .addressfield-popup-container)`)) place(); }, 700);
    place();
  };

  window.__vm.notify = { add, remove, has: (id) => notes.has(id), render, place, barOpened, barClosed, closeBar, row, rowSources, plainRequest,
    drop: () => ({ ...drop }), openFieldButton, quietly, build };
  Promise.resolve(window.__vm.ready).then((cssLoaded) => { if (cssLoaded) start(); }).catch((error) => warn("start", error));
  console.log("[vivarc] notify started");
})();
