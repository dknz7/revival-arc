// Ctrl+Tab switcher, like Arc's (ported from KASOGIT/vivarc#93, 91e1c57, and constrained by Byron, 2026-11-14): hold Ctrl,
// press Tab (Shift+Tab goes back) to step through a row of recent tabs, release Ctrl to switch. It lists only THIS
// window's tabs in the space it shows (Vivaldi's record), most recently used first, so it never switches space or window
// and the repairs (11-space-repair.js) never have anything to fight. Ctrl on a Mac too, as for tab cycling there.
// Vivaldi holds Ctrl+Tab and Ctrl+Shift+Tab (its tab cycling) until 05-bootstrap.js frees them, and it reads its key table
// at launch: while Vivaldi still has them, or whenever that cannot be told, the switcher stands down and Vivaldi's own
// cycling works, so the keys never do two things at once and are never dead.
(() => {
  const SHOWN = 5;
  // A tab's space, as 07-workspaces.js reads it (vivExtData.workspaceId, none = the default space 0). Kept here so the
  // pure part runs on its own in the tests.
  const of = (tab) => {
    try { return Number(JSON.parse(tab?.vivExtData || "{}").workspaceId) || 0; } catch (_) { return 0; }
  };
  // The tabs the switcher lists: this window's, in the space it shows, the tab on screen first, then the others from the
  // most to the least recently used, at most SHOWN. `skip` leaves out tabs the sidebar does not list either (blank tabs,
  // Peek's), never the tab on screen.
  const order = (tabs, { windowId, space, skip = () => false } = {}) => (tabs || [])
    .filter((t) => t.windowId === windowId && of(t) === (space || 0) && (t.active || !skip(t)))
    .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, SHOWN);
  const step = (index, dir, count) => (index + dir + count) % count;
  // Where the selection starts on the first press: the previous tab going forward, the least recent going back. Null when
  // there is no other tab to go to.
  const first = (dir, count) => (count < 2 ? null : step(0, dir, count));
  const NEXT_KEY = "ctrl+tab";
  const PREV_KEY = "ctrl+shift+tab";
  // Whether the switcher takes Ctrl+Tab now. readable: Vivaldi's key table and the run marker could both be read;
  // holders: the Vivaldi commands that hold either key in the table; freedThisRun: Vivarc freed the keys during this run
  // of Vivaldi (05-bootstrap.js; Vivaldi keeps them until the next start). Nothing here depends on a clock. Anything not
  // known stands down: Vivaldi's own cycling then works, so Ctrl+Tab is never dead and never does two things.
  const decision = ({ readable, holders = [], freedThisRun = null } = {}) => {
    if (!readable) return { armed: false, reason: "Vivaldi's shortcut table could not be read: Ctrl+Tab stays Vivaldi's" };
    if (holders.length) return { armed: false, reason: `Vivaldi's ${holders.join(", ")} holds Ctrl+Tab` };
    if (freedThisRun === null) return { armed: false, reason: "could not tell whether Ctrl+Tab was freed during this run: it stays Vivaldi's" };
    if (freedThisRun) return { armed: false, reason: "Ctrl+Tab was freed during this run: Vivaldi keeps it until the next start" };
    return { armed: true, reason: "armed" };
  };
  // A change of Vivaldi's key table seen while this window is open (before / after: the commands holding Ctrl+Tab then and
  // now). Holders now: Vivaldi has the key (the user put it back), so the switcher lets go at once. Holders before and none
  // now: the keys were freed during this run (by the leader window, or by hand), and Vivaldi keeps them until the next
  // start. -> { disarm, freedNow }
  const tableChange = ({ before = null, after = [] } = {}) => ({ disarm: after.length > 0, freedNow: !!before && before.length > 0 && after.length === 0 });
  // Which keys the row takes while it is up: the ones that step and end it. Anything else ends the row without switching
  // and is left to whatever it is for (a key without Ctrl, or Ctrl with another key: Ctrl+C, Ctrl+F).
  const rowKey = (key, ctrl) => {
    if (key === "Escape") return "cancel";
    if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"].includes(key)) return "ignore";
    if (!ctrl) return "leave";
    if (key === "Tab" || key === "ArrowRight" || key === "ArrowLeft") return "step";
    if (key === "Enter") return "commit";
    return "leave";
  };
  // Vivaldi's own word on a key going down or up, wherever the cursor is (tabsPrivate.onKeyboardChanged(windowId, down,
  // modifiers, keyCode), what its own tab cycler ends on; measured on 8.3: with the page holding the cursor, a quick
  // Ctrl+Tab's Ctrl release comes ONLY here, before the row can take the cursor, and never to the UI's own key events).
  // -> "ctrl-down", "ctrl-up", "escape" for this window, else null.
  const CTRL = 17, ESCAPE = 27;
  const keyboardChange = ({ own, windowId, down, keyCode } = {}) => {
    if (typeof own === "number" && typeof windowId === "number" && windowId !== own) return null;
    if (keyCode === CTRL) return down ? "ctrl-down" : "ctrl-up";
    if (keyCode === ESCAPE && down) return "escape";
    return null;
  };
  // The fallback card for a tab with no thumbnail: its site and a letter for it.
  const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  };
  const monogram = (tab) => (hostOf(tab?.url || "") || tab?.title || "?").trim().charAt(0).toUpperCase() || "?";
  window.__vm.switcher = { order, step, first, of, decision, tableChange, rowKey, keyboardChange, hostOf, monogram, SHOWN, NEXT_KEY, PREV_KEY, LATE_MS: 100 };
  if (!window.__vm.store) return;

  const { normalise } = window.__vm;
  const NEXT = normalise(NEXT_KEY);
  const PREV = normalise(PREV_KEY);
  const SHOW_AFTER = 150; // a quick Ctrl+Tab goes to the previous tab without showing the row
  const FIRST_REPEAT = 260;
  const MIN_REPEAT = 45;
  const REPEAT_SPEEDUP = 30;
  const DOUBLE_STEP = 60; // one press can arrive both as Vivaldi's shortcut event and as a key event here
  const SETUP_WAIT_MS = 8000;

  let bar = null;
  let strip = null;
  let items = [];
  let selected = 0;
  let opening = false;
  let lastStep = 0;
  let showTimer = 0;
  let held = { n: 0, at: 0 };
  let keysSeen = false;
  let scope = null; // { windowId, space } the row was opened for
  let ended = null; // what ended the last row (for the tests): a key, the mouse, a click, the window losing focus
  // Whether Ctrl is down, as far as this window's UI can tell: the press itself says it is, and the permanent listeners
  // below hear it go up once the UI has the cursor (the row takes it the moment a press comes in).
  let ctrlDown = false;

  // The tabs Vivarc's lists leave out: blank tabs, and Peek's preview tabs where the Peek module is loaded
  // (window.__vm.peek.isPeekTab).
  const hidden = (t) => !!window.__vm.workspaces?.isBlank?.(t) || !!window.__vm.peek?.isPeekTab?.(t);

  let armed = false;
  let reason = "starting";
  let seenFreed = false; // this window saw the keys go free during this run (the table watch below)
  let lastHolders = null; // the holders at the last read of the table
  const holdersOf = (actions) => {
    const table = Array.isArray(actions) ? actions[0] : null;
    const freeKey = window.__vm.bootstrap?.freeKey;
    if (!table || !freeKey) return null;
    return [...new Set([...freeKey(table, NEXT_KEY).freed, ...freeKey(table, PREV_KEY).freed])];
  };
  // The leader window's profile setup frees the keys; every window waits for its own setup's tab-key step first, so it never
  // reads the table halfway through that (05-bootstrap.js keysReady), at most SETUP_WAIT_MS.
  const decide = async () => {
    let readable = false, holders = [], freedThisRun = false;
    try {
      const ready = window.__vm.bootstrap?.keysReady;
      if (ready) await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, SETUP_WAIT_MS))]);
      const found = holdersOf((await vivaldi.prefs.get("vivaldi.actions"))?.value);
      if (found) {
        holders = found;
        lastHolders = found;
        freedThisRun = seenFreed || !!(await window.__vm.bootstrap?.freedThisRun?.());
        readable = true;
      }
    } catch (_) { readable = false; }
    ({ armed, reason } = decision({ readable, holders, freedThisRun }));
    return armed;
  };
  const decided = decide().then(() => { if (!armed) console.log(`[vivarc] tab switcher waits: ${reason}`); });
  // Vivaldi's key table changing while this window is open (every window, private ones too: vivaldi.prefs is the profile's):
  // Ctrl+Tab back on a Vivaldi command lets go at once; the keys going free marks this run here, which is how a window
  // that cannot see the leader's mark (a private window, with a background page of its own) learns it.
  const onTable = async () => {
    try {
      const after = holdersOf((await vivaldi.prefs.get("vivaldi.actions"))?.value);
      if (!after) return;
      const change = tableChange({ before: lastHolders, after });
      lastHolders = after;
      if (change.freedNow) { seenFreed = true; window.__vm.bootstrap?.markFreedThisRun?.(); }
      if (change.disarm || change.freedNow) {
        ({ armed, reason } = decision({ readable: true, holders: after, freedThisRun: true }));
        if (bar) cancel();
      } else if (!armed) await decide();
    } catch (_) {}
  };
  const pathOf = (x) => (typeof x === "string" ? x : x?.path);
  try { vivaldi.prefs.onChanged?.addListener((change) => { if (pathOf(change) === "vivaldi.actions") onTable(); }); } catch (_) {}

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  let myWindowId = null;
  chrome.windows.getCurrent().then((w) => { myWindowId = w.id; }, () => {});

  // Vivaldi only captures the tab on screen, so a shot is taken a moment after a tab of this window becomes active or
  // finishes loading, and kept (in memory) for the row. A tab not seen since Vivarc loaded shows its icon and site.
  const thumbs = new Map();
  const capture = async (id) => {
    try {
      const shot = await vivaldi.thumbnails.captureTab(id, { encodeFormat: "jpg", encodeQuality: 70, fullPage: false, width: 330, height: 270 });
      if (typeof shot === "string" && shot) thumbs.set(id, shot);
    } catch (_) {}
  };
  const captureSoon = (id, windowId, delay) => {
    if (myWindowId != null && windowId !== myWindowId) return;
    setTimeout(async () => {
      try {
        const [tab] = await chrome.tabs.query(myWindowId != null ? { active: true, windowId: myWindowId } : { active: true, currentWindow: true });
        if (tab?.id === id && !bar) capture(id);
      } catch (_) {}
    }, delay);
  };
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => captureSoon(tabId, windowId, 700));
  chrome.tabs.onUpdated.addListener((id, change, tab) => { if (change.status === "complete" && tab.active) captureSoon(id, tab.windowId, 1500); });
  chrome.tabs.onRemoved.addListener((id) => thumbs.delete(id));

  // The tab's icon, or the letter of its site when it has none (or it fails to load).
  const faviconOf = (tab, cls) => {
    const wrap = el("span", cls);
    const letter = () => {
      const m = el("span", "vm-sw-mono", monogram(tab));
      let hash = 0;
      for (const ch of hostOf(tab.url || "") || "?") hash = (hash * 31 + ch.charCodeAt(0)) % 360;
      m.style.backgroundColor = `hsl(${hash} 38% 40%)`;
      return m;
    };
    if (tab.favIconUrl) {
      const img = el("img");
      img.src = tab.favIconUrl;
      img.addEventListener("error", () => img.replaceWith(letter()));
      wrap.append(img);
    } else wrap.append(letter());
    return wrap;
  };
  const titleOf = (tab) => window.__vm.workspaces?.startTitle?.(tab) || tab.title || tab.url || "";

  const card = (tab, index) => {
    const c = el("div", `vm-sw-card${index === selected ? " sel" : ""}`);
    c.dataset.tabId = String(tab.id);
    const thumb = el("div", "vm-sw-thumb");
    const shot = thumbs.get(tab.id);
    if (shot) thumb.append(Object.assign(el("img"), { src: shot }));
    else {
      thumb.classList.add("vm-sw-nothumb");
      const host = hostOf(tab.url || "");
      thumb.append(faviconOf(tab, "vm-sw-big"), ...(host ? [el("span", "vm-sw-host", host)] : []));
    }
    const label = el("div", "vm-sw-label");
    label.append(faviconOf(tab, "vm-sw-ico"), el("span", "vm-sw-title", titleOf(tab)));
    c.append(thumb, label);
    c.addEventListener("mousemove", () => select(index));
    c.addEventListener("mousedown", (e) => { e.preventDefault(); select(index); ended = "click"; commit(); });
    return c;
  };

  const select = (index) => {
    if (!bar || index === selected) return;
    selected = index;
    if (strip) [...strip.children].forEach((c, i) => c.classList.toggle("sel", i === index));
  };
  const move = (dir) => { if (items.length) select(step(selected, dir, items.length)); };
  const advance = (dir) => {
    const now = Date.now();
    if (!bar || now - lastStep < DOUBLE_STEP) return;
    lastStep = now;
    move(dir);
  };
  // The system repeats a held key at a steady rate; the selection speeds up from one step per 260 ms to one per 45 ms.
  const repeat = (dir) => {
    const now = Date.now();
    if (now - held.at < Math.max(MIN_REPEAT, FIRST_REPEAT - REPEAT_SPEEDUP * held.n)) return;
    held = { n: held.n + 1, at: now };
    move(dir);
  };

  // The page of the tab on screen gets the cursor back (the row took it to hear the keys).
  const refocusPage = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId: scope?.windowId ?? myWindowId });
      document.querySelector(`webview[tab_id="${tab?.id}"]`)?.focus();
    } catch (_) {}
  };
  const close = () => {
    clearTimeout(showTimer);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("blur", onBlur);
    const had = !!bar;
    bar?.remove();
    bar = strip = null;
    items = [];
    keysSeen = false;
    return had;
  };
  // Switches only to a tab still in this window and still in the space the row was opened for: anything else (the tab
  // closed, or moved, or the window switched space meanwhile) switches nothing.
  const commit = async () => {
    const tab = items[selected];
    const at = scope;
    close();
    if (!tab || !at) { refocusPage(); return; }
    try {
      const now = await chrome.tabs.get(tab.id);
      const shown = window.__vm.native?.record()?.activeIn(at.windowId) ?? at.space;
      if (now.windowId !== at.windowId || of(now) !== shown || shown !== at.space) { refocusPage(); return; }
      if (!now.active) await chrome.tabs.update(now.id, { active: true });
      else refocusPage();
    } catch (error) { console.warn("[vivarc] tab switcher:", error); }
  };
  const cancel = () => { if (close()) refocusPage(); };

  // The keys while the row is up: it has the cursor (focused as the press comes in), so Tab, Shift+Tab, the arrows,
  // Escape and Enter come here first. Escape is read before anything else: it never switches, Ctrl held or not.
  // While the row has no cards yet (the tabs being read) only Escape counts.
  const onKeyDown = (e) => {
    const what = rowKey(e.key, e.ctrlKey);
    if (what === "cancel") {
      e.preventDefault();
      e.stopPropagation();
      ended = "Escape";
      cancel();
      return;
    }
    if (what === "ignore" || !items.length) return;
    if (what === "leave") { ended = `${e.ctrlKey ? "Ctrl+" : ""}${e.key}: not the switcher's`; cancel(); return; } // not swallowed, nothing switched
    e.preventDefault();
    e.stopPropagation();
    if (what === "step") {
      keysSeen = true;
      const dir = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
      if (e.repeat) repeat(dir);
      else { held = { n: 0, at: Date.now() }; advance(dir); }
    } else if (what === "commit") {
      ended = "Enter";
      commit();
    }
  };
  // Ctrl, always: the release ends a row that is up or still being made (opening then switches without showing it).
  let ctrlSeenAt = 0; // the last time this window's UI saw Ctrl held (a keydown with it)
  window.addEventListener("keydown", (e) => { if (e.key === "Control") ctrlDown = true; if (e.ctrlKey) ctrlSeenAt = Date.now(); }, true);
  const released = (how) => {
    ctrlDown = false;
    if (bar && items.length) { ended = how; commit(); }
  };
  window.addEventListener("keyup", (e) => { if (e.key === "Control") released("Ctrl released"); }, true);
  // The same from Vivaldi, which hears the keys the page gets too: a quick press's release (see keyboardChange). A row whose
  // cards are not made yet switches without showing as soon as they are (open() reads ctrlDown).
  try {
    vivaldi.tabsPrivate.onKeyboardChanged.addListener((windowId, down, _modifiers, keyCode) => {
      const what = keyboardChange({ own: window.vivaldiWindowId, windowId, down, keyCode });
      if (what === "ctrl-down") { ctrlDown = true; ctrlSeenAt = Date.now(); }
      else if (what === "ctrl-up") released("Ctrl released");
      else if (what === "escape" && bar) { ended = "Escape"; cancel(); }
    });
  } catch (error) { console.warn("[vivarc] tab switcher: no key events from Vivaldi", error); }
  // A Ctrl released before the row had the cursor never reaches it: the next move of the mouse without Ctrl ends it. Only a
  // real move: the row appearing under a still pointer makes the browser send a mousemove of its own, with no movement.
  const onMouseMove = (e) => { if (!e.ctrlKey && (e.movementX || e.movementY)) { ctrlDown = false; ended = "mouse moved without Ctrl"; commit(); } };
  const onBlur = () => { ended = "window lost focus"; cancel(); };

  // The row's element, empty and hidden, takes the cursor at once, so the release of Ctrl that follows a quick press comes
  // to this window's UI rather than to the page; its cards come once the tabs are read.
  const takeKeys = () => {
    bar = el("div");
    bar.id = "vm-switch";
    bar.tabIndex = -1;
    bar.setAttribute("role", "listbox");
    bar.setAttribute("aria-label", "Recent tabs in this space");
    bar.addEventListener("mousedown", (e) => { if (e.target === bar) { ended = "click outside"; cancel(); } });
    (document.querySelector("#browser") || document.body).append(bar);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("blur", onBlur);
    const focus = () => bar?.focus();
    focus();
    setTimeout(focus, 60);
  };

  const open = async (dir) => {
    if (opening || bar) return;
    opening = true;
    ended = null;
    const pressedAt = Date.now();
    let tabs = [];
    try {
      await decided;
      // Not armed when this window started (or since): ask again, the setup or a read may have settled meanwhile.
      if (!armed && !(await decide())) return;
      // An answer that came late (the setup still running, a slow read): the press is not acted on unless Ctrl is seen held
      // since, so the row never pops up and takes the cursor long after a quick press. The next press is fast.
      if (Date.now() - pressedAt > window.__vm.switcher.LATE_MS && ctrlSeenAt < pressedAt) { ended = "decided too late"; return; }
      takeKeys();
      const windowId = myWindowId ?? (await chrome.windows.getCurrent()).id;
      const all = await chrome.tabs.query({ windowId });
      const space = window.__vm.native?.record()?.activeIn(windowId) ?? window.__vm.workspaces?.activeId?.(all) ?? 0;
      scope = { windowId, space };
      tabs = order(all, { windowId, space, skip: hidden });
    } catch (error) {
      console.warn("[vivarc] tab switcher:", error);
      cancel();
      return;
    } finally { opening = false; }
    if (!bar) return; // ended while the tabs were read (Escape, the window lost focus)
    const start = first(dir, tabs.length);
    if (start == null) { cancel(); return; }
    items = tabs;
    selected = start;
    // Ctrl already released (a quick Ctrl+Tab): the previous tab, without showing the row.
    if (!ctrlDown) { ended = "Ctrl released before the row"; commit(); return; }
    lastStep = held.at = Date.now();
    held.n = 0;
    strip = el("div", "vm-sw-strip");
    strip.append(...items.map(card));
    const panel = el("div", "vm-sw-panel");
    panel.append(strip);
    bar.append(panel);
    showTimer = setTimeout(() => bar?.classList.add("in"), SHOW_AFTER);
    const current = items[0];
    capture(current.id).then(() => {
      const img = thumbs.get(current.id);
      const thumb = strip?.children[0]?.querySelector(".vm-sw-thumb");
      if (img && thumb) { thumb.classList.remove("vm-sw-nothumb"); thumb.replaceChildren(Object.assign(el("img"), { src: img })); }
    });
  };

  // Every window hears every key: only the window it was pressed in opens its row (the event's window id, as Ctrl+S does
  // in 12-sidebar-hide.js; without both ids, the window Chromium says is focused).
  const here = (pressedIn, focused) => {
    const own = window.vivaldiWindowId;
    const shared = window.__vm.sidebarHide?.pressedHere;
    if (shared) return shared(pressedIn, own, focused);
    return typeof pressedIn === "number" && typeof own === "number" ? pressedIn === own : !!focused;
  };
  window.__vm.onShortcut((key, _combo, pressedIn) => {
    if (key !== NEXT && key !== PREV || !window.__vm.cssLoaded) return;
    const dir = key === NEXT ? 1 : -1;
    const act = (focused) => {
      if (!here(pressedIn, focused)) return;
      if (!bar) { ctrlDown = true; open(dir); } // the press itself is Ctrl down
      else if (!keysSeen) advance(dir);
    };
    if (typeof pressedIn === "number" && typeof window.vivaldiWindowId === "number") act(false);
    else chrome.windows.getCurrent().then((win) => act(win.focused), () => {});
  });

  Object.assign(window.__vm.switcher, {
    state: () => ({ armed, reason, open: !!bar, shown: !!bar?.classList.contains("in"), items: items.map((t) => t.id), selected, scope, ended }),
    recheck: () => decide().then(() => ({ armed, reason })),
  });
  console.log("[vivarc] tab switcher started");
})();
