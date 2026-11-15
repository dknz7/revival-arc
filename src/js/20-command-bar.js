// Vivarc command bar. Opens whenever a blank new tab is created (Cmd+T bound to "New Tab",
// the sidebar "+ New Tab" row). The blank tab is navigated to the choice, or closed on Escape.
(() => {
  // What a blank tab is, and the start page the user asked for (which is not one), is workspaces.isBlank (07-workspaces.js).
  // One argument only: it is passed to filter/every, whose index would be taken for the second.
  const isBlank = (tab) => window.__vm.workspaces.isBlank(tab);
  // A tab the bar opens empty over: a blank one, or a private window's introduction page (Task 9b).
  const startsEmpty = (tab) => isBlank(tab) || !!window.__vm.workspaces.privateIntro?.(tab);
  const startedAt = Date.now();

  const DEFAULT = {}; // Marks rows that resolve Vivaldi's current default at execution time.
  const search = window.__vm.search;
  // Built-in search shortcuts (keyword + Tab). Engines from the user's Vivaldi settings win on a clash.
  const SEED = [
    ["az", "Amazon", "https://www.amazon.com/s?k={searchTerms}"],
    ["b", "Bing", "https://www.bing.com/search?q={searchTerms}"],
    ["d", "DuckDuckGo", "https://duckduckgo.com/?q={searchTerms}"],
    ["g", "Google", "https://www.google.com/search?q={searchTerms}"],
    ["gc", "Calendar", "https://calendar.google.com/calendar/u/0/r/search?q={searchTerms}"],
    ["gd", "Drive", "https://drive.google.com/drive/search?q={searchTerms}"],
    ["gh", "GitHub", "https://github.com/search?q={searchTerms}"],
    ["gm", "Gmail", "https://mail.google.com/mail/u/0/#search/{searchTerms}"],
    ["li", "LinkedIn", "https://www.linkedin.com/search/results/all/?keywords={searchTerms}"],
    ["m", "Maps", "https://www.google.com/maps/search/{searchTerms}"],
    ["mdn", "MDN", "https://developer.mozilla.org/en-US/search?q={searchTerms}"],
    ["npm", "npm", "https://www.npmjs.com/search?q={searchTerms}"],
    ["r", "Reddit", "https://www.reddit.com/search/?q={searchTerms}"],
    ["so", "Stack Overflow", "https://stackoverflow.com/search?q={searchTerms}"],
    ["tr", "Translate", "https://translate.google.com/?sl=auto&text={searchTerms}&op=translate"],
    ["w", "Wikipedia", "https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}"],
    ["x", "X", "https://x.com/search?q={searchTerms}"],
    ["yt", "YouTube", "https://www.youtube.com/results?search_query={searchTerms}"],
  ].map(([keyword, name, url]) => ({ keyword, name, url }));
  const CHIP_COLORS = {
    yt: "#ff0000", g: "#4285f4", d: "#de5833", r: "#ff4500", gh: "#24292f", m: "#188038", w: "#636466",
    gm: "#ea4335", gd: "#188038", gc: "#4285f4", li: "#0a66c2", x: "#111111", so: "#f48024", npm: "#cb3837", mdn: "#1b1b1b",
  };

  let engines = SEED;
  (async () => {
    try {
      const { engines: templates } = await search.templates();
      const list = templates
        .filter((t) => t.keyword && t.url && !t.keyword.startsWith("@"))
        .map((t) => ({ ...t }));
      const taken = new Set(list.map((t) => t.keyword.toLowerCase()));
      engines = [...list, ...SEED.filter((e) => !taken.has(e.keyword))];
    } catch (_) {}
  })();

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const SEARCH_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>';
  const ARROW_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  };
  // A search suggestion that is itself a web address (http:// or https://) opens it, as Vivaldi's own field does
  // (KASOGIT/vivarc#108). It goes through the resolver like typed text, so only a valid address navigates; anything
  // else, a malformed address included, stays a search suggestion (Task 9b: a suggestion is never handed over).
  const suggestionRow = (p) => {
    const meant = /^https?:\/\//i.test(p) ? search.resolve?.(p) : null;
    return meant?.kind === "url"
      ? { type: "url", url: meant.url, label: p, sub: "Open" }
      : { type: "suggest", engine: DEFAULT, query: p, label: p };
  };

  const toast = (message) => window.dispatchEvent(new CustomEvent("vm-toast", { detail: message }));
  // A new tab tops its space's list, as in Arc (workspaces.topIndex). Ctrl+T's blank tab, which Vivaldi puts next to
  // the active tab, moves there once it has an address; so does one the bar creates (+ New Tab, palette pages), as
  // Vivaldi's tabs.create ignores `index` (measured on 8.2). Vivaldi files a tab the bar creates in the window's
  // space itself, so Vivarc writes no space onto it. Never moved: a tab in a folder (moving it would split the stack),
  // a split view's new pane (it belongs beside its partner), and the page whose address Cmd+L edits.
  const keepInPlace = new Set();
  const toTop = async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    if (window.__vm.stacks?.stackOf(tab)) return;
    const index = window.__vm.workspaces.topIndex(await chrome.tabs.query({ windowId: tab.windowId }), tab);
    if (index != null) await chrome.tabs.move(tabId, { index });
  };
  const openNew = async (url) => {
    const created = await chrome.tabs.create({ url });
    await toTop(created.id).catch((error) => console.warn("[vivarc] new tab to the top:", error));
    return created;
  };
  // Vivaldi's Start Page (Speed Dials), asked for: the New Tab dropdown's Start Page row, or its address typed here. The tab
  // carries the vmStart mark, which makes it a page like any other (workspaces.isBlank): no command bar opens over it
  // and the sidebar lists it. `creating` holds the bar back from the tab made here, whose onCreated arrives before the
  // mark is written. The mark is cleared when the tab navigates out of the start page's family (see onUpdated below).
  let creating = 0;
  const markStart = (id) => window.__vm.setExtData({ id }, { [window.__vm.workspaces.START_KEY]: true });
  const openStartPage = async () => {
    creating++;
    try {
      const created = await chrome.tabs.create({ url: window.__vm.workspaces.START_URL, active: true });
      await markStart(created.id);
      await toTop(created.id).catch((error) => console.warn("[vivarc] new tab to the top:", error));
      return created;
    } finally { setTimeout(() => { creating--; }, 1000); }
  };
  window.__vm.openStartPage = openStartPage; // shared with the sidebar's New Tab dropdown
  // Show url in the bar's target tab, or in a new tab when it has none.
  const show = async (id, isNew, url) => {
    if (window.__vm.workspaces.startTyped(url)) { // the start page's address typed: it is where the user asked to go, and stays
      if (id == null) return openStartPage();
      await markStart(id);
      await chrome.tabs.update(id, { url: window.__vm.workspaces.START_URL, active: true });
      if (isNew) await toTop(id).catch((error) => console.warn("[vivarc] new tab to the top:", error));
      return;
    }
    if (id == null) return openNew(url);
    await chrome.tabs.update(id, { url, active: true });
    if (isNew) await toTop(id).catch((error) => console.warn("[vivarc] new tab to the top:", error));
  };
  const openPage = (url) => openNew(url);
  const press = (node) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    }
  };
  const findDownloadsButton = () => {
    const host = document.querySelector('[data-name="PanelDownloads"]');
    if (host) return host.querySelector("button") || host;
    return [...document.querySelectorAll("#browser button, #browser [role=button]")]
      .find((n) => /download|téléchar/i.test(`${n.title} ${n.getAttribute("aria-label") || ""} ${n.className}`));
  };
  const openDownloads = () => {
    const button = findDownloadsButton();
    if (button) press(button);
    else chrome.downloads?.showDefaultFolder?.();
  };
  const setExtData = (tab, patch) => window.__vm.setExtData(tab, patch); // shared with the sidebar's tear-off
  // Split view like Arc's: the page behind the bar and a new tab form a fresh Vivaldi tile group. "row" puts them
  // side by side, "column" one above the other (measured from the rendered panes in Vivaldi 8.2). If the page was
  // already in a group it leaves it. Vivaldi only honours the layout when every tile gets its data at once, so both
  // tabs are written together and once more shortly after. The new tab opens the command bar for its address.
  const splitView = async (tab, layout) => {
    const fresh = await chrome.tabs.get(tab.id);
    const previous = window.__vm.tilingOf(fresh);
    const others = previous
      ? (await chrome.tabs.query({ currentWindow: true })).filter((t) => t.id !== fresh.id && window.__vm.tilingOf(t)?.id === previous.id)
      : [];
    const created = await chrome.tabs.create({ active: true, index: fresh.index + 1 });
    keepInPlace.add(created.id); // the bar opens on this pane; Enter must not move it away from its partner
    const id = crypto.randomUUID();
    const write = () => Promise.all([fresh, created].map((t, index) =>
      setExtData(t, { tiling: { id, layout, type: "selection", index } })));
    await write();
    setTimeout(() => write().catch(() => {}), 400);
    if (others.length === 1) await setExtData(others[0], { tiling: null });
    else await Promise.all(others.map((t, index) => setExtData(t, { tiling: { ...window.__vm.tilingOf(t), index } })));
  };
  const closeSplitView = (tab) => window.__vm.unsplit(tab); // shared with the sidebar's tear-off
  window.__vm.splitView = splitView; // shared with the sidebar's tab menu (Split View rows)

  // Quick actions, matched against what is typed. `tab` actions apply to the page behind the bar.
  const ACTIONS = [
    { label: "View History", words: "history visited", run: () => openPage("vivaldi://history") },
    { label: "View Downloads", words: "downloads files", run: openDownloads },
    { label: "View Bookmarks", words: "bookmarks saved", run: () => openPage("vivaldi://bookmarks") },
    { label: "Open Settings", words: "settings preferences options", run: () => openPage("vivaldi://settings") },
    { label: "Create New Space (Ctrl+Cmd+N)", words: "space workspace new create add", run: () => toast(window.__vm.workspaces.CREATE_HINT) },
    { label: "Manage Extensions", words: "extensions addons", run: () => openPage("vivaldi://extensions") },
    { label: "Pin This Tab", words: "pin bookmark", tab: true, run: async (tab) => {
      if (await window.__vm.pinTab?.(tab, "Pinned")) toast("Pinned Tab");
      else toast("Could not pin the tab: this space has no bookmark folder yet");
    } },
    { label: "Add This Tab to Favorites", words: "favorite pin", tab: true, run: async (tab) => {
      if (await window.__vm.pinTab?.(tab, "Favorites")) toast("Added to Favorites");
      else toast("Could not add the tab to Favorites: no bookmark folder yet");
    } },
    { label: "Copy Current URL", words: "copy link address share", tab: true, run: async (tab) => {
      await navigator.clipboard?.writeText(tab.url).catch(() => {});
      toast("Copied Current URL");
    } },
    { label: "Split View: Side by Side", words: "split tile vertical columns", tab: true, run: (tab) => splitView(tab, "row") },
    { label: "Split View: Top and Bottom", words: "split tile horizontal rows", tab: true, run: (tab) => splitView(tab, "column") },
    { label: "Close Split View", words: "unsplit untile split", tab: true, when: (tab) => !!window.__vm.tilingOf(tab), run: closeSplitView },
    { label: "Duplicate Tab", words: "clone copy", tab: true, run: (tab) => chrome.tabs.duplicate(tab.id) },
    { label: "Mute / Unmute Tab", words: "sound audio silence", tab: true, run: (tab) =>
      chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted }) },
    { label: "Close Tab", words: "quit remove", tab: true, run: (tab) => chrome.tabs.remove(tab.id) },
    // Ported from KASOGIT/vivarc#143: a picker of the other spaces; the tab moves and you go with it, as in Arc.
    { label: "Move Tab to Space…", words: "move space workspace send", tab: true, stay: true,
      when: () => (window.__vm.spaceTargets?.() || []).length > 0, run: (tab) => setMode(moveToSpacePicker(tab)) },
    { label: "Reopen Closed Tab", words: "restore undo", run: () => chrome.sessions.restore() },
    { label: "New Window", words: "open window", run: () => chrome.windows.create({}) },
    { label: "New Private Window", words: "incognito private", run: () => chrome.windows.create({ incognito: true }) },
    { label: "Vivarc Guide", words: "welcome help shortcuts tour start", run: () => {
      const url = window.__vm.config.startUrl;
      return url ? openPage(url) : undefined;
    } },
    { label: "Collapse All Folders", words: "close fold folders pinned sidebar", run: () => {
      window.dispatchEvent(new CustomEvent("vm-folders", { detail: "collapse" }));
      toast("Collapsed all folders");
    } },
    { label: "Expand All Folders", words: "open unfold folders pinned sidebar", run: () => {
      window.dispatchEvent(new CustomEvent("vm-folders", { detail: "expand" }));
      toast("Expanded all folders");
    } },
    { label: "Vivarc Settings", words: "preferences options configure features toggle glass", run: () => window.dispatchEvent(new CustomEvent("vm-open-settings")) },
    // The "Dia layout" setting: whichever layout is not the current one.
    { label: "Layout: Dia", words: "layout dia top bar toolbar row", when: () => !window.__vm.settings.get("diaLayout"),
      run: () => { window.__vm.settings.set("diaLayout", true); toast("Dia layout"); } },
    { label: "Layout: Arc", words: "layout arc sidebar classic", when: () => !!window.__vm.settings.get("diaLayout"),
      run: () => { window.__vm.settings.set("diaLayout", false); toast("Arc layout"); } },
    { label: "Edit Theme", words: "color appearance sidebar", run: () => window.dispatchEvent(new CustomEvent("vm-open-theme")) },
  ];
  // A picker is a mode of the bar that lists choices instead of pages (#143): pick(text) returns rows { label, sub, run };
  // Enter runs the chosen one and closes the bar, Backspace on an empty field leaves it, like an engine chip. Move Tab to
  // Space lists the spaces the sidebar's own Move to <Space> offers (10-sidebar.js), moves the tab with Vivarc's move
  // (native.moveToSpace: Vivaldi's own on 8.2, setSpace into the right window on 8.3), then takes you to it the way a picked
  // tab is reached (pickTab: the window switches to its space, or the window showing that space comes forward).
  const moveToSpacePicker = (tab) => ({ name: "Move to Space", placeholder: "Move this tab to…",
    pick: (text) => (window.__vm.spaceTargets?.() || [])
      .filter((space) => space.name.toLowerCase().includes(text.trim().toLowerCase()))
      .map((space) => ({ label: space.name, sub: "Space", run: () => moveAndGo(tab, space) })) });
  const moveAndGo = async (tab, space) => {
    try {
      await window.__vm.native.moveToSpace([tab.id], space.id);
      window.__vm.spaceRepair?.schedule?.();
      await pickTab(await chrome.tabs.get(tab.id));
      toast(`Moved to ${space.name}`);
    } catch (error) {
      console.warn("[vivarc] move tab to space:", error);
      toast(error?.code === "parked-elsewhere" ? "That space is in another window. Show it there first, then move the tab." : "Could not move the tab.");
    }
  };
  const ACTION_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>';

  let bar = null;
  let input = null;
  let list = null;
  let chipHolder = null;
  let targetTab = null;
  let keepTarget = false; // the target is an empty space's own blank tab: closing the bar must not close it
  let editing = null; // the URL of the current page, edited in the bar: that page is the target, kept, and behind the bar
  let openedAt = 0;
  let mode = null;
  let rows = [];
  let selected = 0;
  let seq = 0;
  let autoCompleted = false;
  let typed = ""; // what the user typed (an arrowed-to row fills the field around it, #129)
  // Light counters for the sandbox (a full sweep reports them): the bar's computations and those dropped as stale.
  const perf = { computeStarted: 0, computeDropped: 0, fieldRoutes: 0 };
  window.__vm.perf = { ...(window.__vm.perf || {}), commandBar: perf };

  const iconFor = (url, favicon) => {
    const wrap = el("span", "vm-cmd-ico");
    if (favicon) {
      const img = el("img");
      img.src = favicon;
      img.addEventListener("error", () => wrap.replaceChildren(letter(url)));
      wrap.append(img);
    } else {
      wrap.append(letter(url));
    }
    return wrap;
  };
  const letter = (url) => {
    const host = hostOf(url) || "?";
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    const span = el("span", "vm-cmd-letter", host[0].toUpperCase());
    span.style.backgroundColor = `hsl(${hash} 38% 40%)`;
    return span;
  };

  const close = (removeBlank) => {
    const blank = targetTab;
    const keep = keepTarget;
    const was = !!bar;
    try { window.__vm.notify?.barClosed(); } catch (error) { console.warn("[vivarc] fly-up:", error); }
    flyObserver?.disconnect();
    flyObserver = null;
    bar?.remove();
    if (was) window.dispatchEvent(new CustomEvent("vm-command-bar", { detail: { open: false } }));
    bar = input = list = chipHolder = targetTab = mode = null;
    keepTarget = false;
    editing = null;
    rows = [];
    seq++;
    if (removeBlank && blank != null && !keep) chrome.tabs.remove(blank).catch(() => {});
  };

  // Vivaldi refuses some addresses from a mod (a scheme it keeps to its own field): they go through its field instead.
  // data: addresses go to Vivaldi's own field, shown for the user's Enter (measured on 8.3: a data: address set by the bar
  // with chrome.tabs.update left the tab where it was without an error; and a data: page can run a script).
  const go = (url) => {
    const id = targetTab;
    const isNew = editing === null && !keepInPlace.has(id);
    close(false);
    if (/^data:/i.test(url)) { nativeEntry(url, { tabId: id, submit: false }); return; }
    show(id, isNew, url).catch((error) => {
      console.warn("[vivarc] open:", error);
      nativeEntry(url, { tabId: id, submit: true });
    });
  };

  // ---- Vivaldi's own address field, for one entry (Task 9b fix round 1) ----
  // The command bar is the only place to type an address, so what it cannot do is handed to Vivaldi's own field, shown
  // for that one entry where Vivarc's toasts drop (vivarc.css, vm-native-field) and hidden again once it loses the cursor:
  // - "Open in Vivaldi's address field", the last row whenever something is typed: anything (an extension's omnibox
  //   keyword, Vivaldi's own suggestions), the text carried over, the user finishing it there;
  // - a javascript: address (the lead row; running it in the page stays Vivaldi's decision, and the user's Enter);
  // - a search engine that searches by POST (the bar navigates by address only): submitted at once, so Vivaldi runs its
  //   own engine, never another;
  // - an address Vivaldi refuses to load from a mod (go, above): submitted at once.
  // The tab: the bar's own (made active first), or for Ctrl+T's bar, which has none, a new one.
  let nativeOpen = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Each hand-over is a session (Task 9b fix round 2): its tab and window, its timers and its listeners. A newer hand-over
  // ends the one before it; only the current session may change the shared state (handing, nativeOpen, the class), and
  // ending a session cancels all its timers, so an old one can never tear down a newer one. It ends on the field's blur,
  // when the field loses the cursor (a watch), 600 ms after a submit, on any failure, and when its tab stops being the
  // active one in this window (a switch or the tab's removal).
  // `handing` is up from the first step: the tab made or activated for the entry is the session's own (the bar's new-tab
  // path and the focus route leave it alone), and nothing is typed or submitted unless that tab is the active one, so an
  // entry can never land in another page.
  let handing = false;
  let session = null;
  const nativeFieldEntry = async (text, { tabId = null, submit = false } = {}) => {
    const browser = document.querySelector("#browser");
    if (!browser) return false;
    session?.end();
    const me = { tab: null, field: null, timers: new Set(), ended: false };
    session = me;
    handing = true;
    const later = (fn, ms, every = false) => { const t = every ? setInterval(fn, ms) : setTimeout(fn, ms); me.timers.add({ t, every }); return t; };
    const onBlur = () => later(() => { if (document.activeElement !== me.field) me.end(); }, 150);
    me.end = () => {
      if (me.ended) return;
      me.ended = true;
      for (const { t, every } of me.timers) (every ? clearInterval : clearTimeout)(t);
      me.timers.clear();
      me.field?.removeEventListener("blur", onBlur);
      if (session !== me) return; // a newer hand-over owns the shared state now
      session = null;
      handing = false;
      if (nativeOpen) { nativeOpen = false; document.querySelector("#browser")?.classList.remove("vm-native-field"); }
    };
    try {
      let tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (me.ended) return false;
      if (!tab) tab = await chrome.tabs.create({ active: true });
      else if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
      me.tab = tab.id;
      await wait(250); // Vivaldi's field follows the active tab
      if (me.ended) return false;
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      me.field = document.querySelector("#tabs-tabbar-container .UrlBar-AddressField #urlFieldInput");
      if (me.ended) return false;
      if (active?.id !== tab.id || !me.field) { toast("Vivaldi's address field is not available here"); me.end(); return false; }
      nativeOpen = true;
      document.querySelector("#browser")?.classList.add("vm-native-field");
      window.__vm.notify?.place?.();
      me.field.addEventListener("blur", onBlur);
      focusOf(me.field);
      if (document.activeElement !== me.field) { me.end(); toast("Vivaldi's address field did not take the cursor"); return false; }
      later(() => { if (document.activeElement !== me.field) me.end(); }, 1000, true);
      // React owns the field's value: written through the input's own setter, then told with an input event.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(me.field, text);
      me.field.dispatchEvent(new Event("input", { bubbles: true }));
      me.field.setSelectionRange?.(text.length, text.length);
      // The final boundary: an address that could run a script (javascript:, vbscript:, data:) is never submitted, however
      // it got here (nativeEntry checks first too).
      if (submit && !neverSubmit(text) && !me.ended) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          me.field.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
        later(() => me.end(), 600);
      }
      return true;
    } catch (error) {
      me.end();
      throw error;
    }
  };
  const handedTabChanged = (tabId, windowId) => {
    if (session && session.tab != null && windowId === myWindow && tabId !== session.tab) session.end();
  };
  chrome.tabs.onActivated?.addListener(({ tabId, windowId }) => handedTabChanged(tabId, windowId));
  chrome.tabs.onRemoved?.addListener((tabId) => { if (session && session.tab === tabId) session.end(); });
  // Replaceable (search.test.cjs records the hand-overs instead of driving a field). The boundary every hand-over passes,
  // handOver's too: a text that could run a script (javascript:, vbscript:, data:; search.neverSubmit) is shown, never
  // submitted, and without that check nothing is submitted at all.
  const neverSubmit = (text) => (typeof search?.neverSubmit === "function" ? search.neverSubmit(text) : true);
  const nativeEntry = (text, options = {}) => Promise.resolve()
    .then(() => (window.__vm.nativeEntry || nativeFieldEntry)(text, { ...options, submit: !!options.submit && !neverSubmit(text) }))
    .catch((error) => { console.warn("[vivarc] Vivaldi's address field:", error); return false; });

  const runSearch = async (engine, query) => {
    const id = targetTab;
    const isNew = editing === null && !keepInPlace.has(id);
    const currentInput = input;
    try {
      const chosen = engine === DEFAULT ? await search.defaultEngine() : engine;
      const request = await search.request(chosen, query);
      // Do not navigate a stale command bar after it was closed or replaced.
      if (input !== currentInput) return;
      // A POST engine, or anything but a web address: Vivaldi's own field runs the search, told which engine by that
      // engine's own keyword (the default's too, so the words are never read as an address or another engine's keyword).
      // Without a keyword the search cannot be told as a search: the words are shown in the field, not submitted. Words
      // that would run a script are never submitted either.
      if (request.postParams || !/^https?:\/\//i.test(request.url || "")) {
        close(false);
        delegate(chosen, query, id);
        return;
      }
      await show(id, isNew, request.url);
      close(false);
    } catch (error) {
      // Vivaldi's engines could not be read or asked: the engine cannot be named, so the words are shown in Vivaldi's own
      // field for the user to confirm, never submitted, never to another engine.
      console.warn('[vivarc] search through the command bar failed; showing it in Vivaldi\'s address field:', error);
      if (input !== currentInput || !input) return;
      close(false);
      delegate(engine === DEFAULT ? null : engine, query, id);
    }
  };
  const delegate = (engine, query, tabId) => {
    const keyword = engine?.keyword && !/\s/.test(engine.keyword) ? engine.keyword : null;
    return nativeEntry(keyword ? `${keyword} ${query}` : query, { tabId, submit: !!keyword && !neverSubmit(query) });
  };

  // The bar lists every tab of the window, parked ones included. A parked tab activated as it is leaves Vivaldi's record
  // on the space shown (G1), and repair 2 would snap the window back: its space is shown first (workspaces.tabPick).
  // Without the record or the switch, the tab is activated as it always was. The bar's own blank tab is closed after,
  // so it never hands the screen to some other tab in between.
  // A tab whose space was deleted (a Recently Closed restore brings it back with the dead id on Vivaldi 8.3, task 8y) is
  // never switched to: it is moved (native.setSpace) into the space on screen in the window it was picked in, then
  // activated there (Byron, 2026-11-14: a restored tab comes to the window you clicked in). If it was on screen in another
  // window, that window's most recent tab of its own space takes the screen first.
  // Fix round 3: the action is worked out once, at the moment it runs, from what is true then: the tab, the window
  // asking, and the list are read together, Vivaldi's record is read right after (it answers synchronously), and the
  // pick is made on those, never on what the bar saw when it listed the tab. A tab is moved only on positive evidence: a
  // valid list showing its current space is gone (an unreadable list moves nothing and switches to no named space: the
  // tab is then only activated where it is). A named switch target comes from the tab's current space, which that list
  // holds.
  const pickTab = async (listed) => {
    const native = window.__vm.native;
    const spaces = window.__vm.workspaces;
    const withRecord = !!(native?.hasSwitch() && native.record() && spaces);
    const [current, here, known] = await Promise.all([
      chrome.tabs.get(listed.id).catch(() => null), chrome.windows.getCurrent().then((w) => w?.id, () => undefined),
      withRecord ? native.spaceIds().then(spaces.spaceList, () => null) : Promise.resolve(null)]);
    // The listed row is never acted on: a tab that can't be read now (closed since the bar listed it) gets no switch, no
    // focus, nothing (fix round 4).
    if (!current) return;
    const tab = current;
    const record = withRecord ? native.record() : null;
    const pick = record ? spaces.tabPick(tab, record.activeIn(tab.windowId), record.all().get(spaces.of(tab)) ?? null,
      { known, here, hereShown: here != null ? record.activeIn(here) : null }) : { kind: "activate" };
    // Focusing a minimised window leaves it in the taskbar: it is brought back to normal.
    const minimised = async (id) => { try { return (await chrome.windows.get(id))?.state === "minimized"; } catch (_) { return false; } };
    if (pick.kind === "focus") {
      if (await minimised(pick.window)) await chrome.windows.update(pick.window, { state: "normal", focused: true });
      return native.focus(pick.window);
    }
    if (pick.kind === "adopt") {
      if (!current) return chrome.tabs.update(tab.id, { active: true }).catch(() => {}); // gone or unreadable: no move
      return bringHere(current, pick.window, pick.space, record);
    }
    // tabPick names a space for a switch only when the list holds it (or it is the default space)
    if (pick.kind === "switch") await native.switchTo(pick.window, pick.space);
    await chrome.tabs.update(tab.id, { active: true });
    // The sidebar's Open Tabs list can pick a tab of another window, which activating does not bring forward.
    if (here != null && tab.windowId != null && here !== tab.windowId) {
      await chrome.windows.update(tab.windowId, (await minimised(tab.windowId)) ? { state: "normal", focused: true } : { focused: true });
    }
  };
  window.__vm.pickTab = pickTab; // shared with the sidebar's New Tab dropdown (Open Tabs) and Recently Cleaned

  // Into `space` in window `windowId` (setSpace), then on screen there. A tab on screen in another window first hands
  // that window's screen to its most recent tab of its own space.
  const bringHere = async (tab, windowId, space, record, { activate = true } = {}) => {
    const native = window.__vm.native, spaces = window.__vm.workspaces;
    if (tab.active && windowId !== tab.windowId) {
      const own = record?.activeIn(tab.windowId) ?? 0;
      const keeper = spaces.recentTab((await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => t.id !== tab.id), own);
      if (keeper) await chrome.tabs.update(keeper.id, { active: true });
    }
    await native.setSpace(tab.id, space, { windowId });
    if (activate) await chrome.tabs.update(tab.id, { active: true });
  };

  // A tab restored from Recently Closed (Byron, 2026-11-14: it comes to the window you clicked in, whatever its space;
  // Vivaldi puts it back in its old window). workspaces.restorePlan says into which space: its own when that space can
  // be shown here (the default space, or a live space living here or nowhere), else the one on screen here. The window
  // switches to that space when it shows another one (a named space checked again first). Without Vivaldi's record or
  // switch, the tab is only brought into this window and activated.
  const restoreTab = async (listed) => {
    const tab = (await chrome.tabs.get(listed.id).catch(() => null)) || listed;
    const native = window.__vm.native, spaces = window.__vm.workspaces;
    const here = (await chrome.windows.getCurrent().catch(() => null))?.id ?? tab.windowId;
    const record = native?.hasSwitch() ? native.record() : null;
    if (!record || !spaces) {
      if (tab.windowId !== here) await chrome.tabs.move(tab.id, { windowId: here, index: -1 });
      return chrome.tabs.update(tab.id, { active: true });
    }
    // Only on a valid list: unreadable, nothing can be told about the tab's space, so it is not moved (the ordinary pick)
    const known = spaces.spaceList(await native.spaceIds());
    if (!known) return pickTab(tab);
    const plan = spaces.restorePlan({ tab, here, hereShown: record.activeIn(here), known, record: record.all(),
      tabs: await chrome.tabs.query({ windowType: "normal" }) });
    let space = plan.space;
    const now = spaces.spaceList(await native.spaceIds());
    if (!now) return pickTab(tab);
    if (space && !now.includes(space)) space = 0; // gone meanwhile
    if (tab.windowId !== here || spaces.of(tab) !== space) await bringHere(tab, here, space, record, { activate: false });
    if (space !== (record.activeIn(here) ?? 0)) await native.switchTo(here, space);
    await chrome.tabs.update(tab.id, { active: true });
  };
  window.__vm.restoreTab = restoreTab; // the sidebar's Recently Closed
  // An empty space's blank tab, kept by the bar as a landing in an empty space is (18-empty-space.js: its last tab closed).
  window.__vm.openEmptySpace = (tabId, windowId) => open(tabId, windowId, true);

  const run = (row) => {
    if (!row || (row.type === "search" && !row.query)) return;
    if (row.type === "tab") {
      const blank = keepTarget ? null : targetTab;
      close(false);
      pickTab(row.tab).catch((e) => console.warn("[vivarc] switch to tab:", e))
        .finally(() => { if (blank != null) chrome.tabs.remove(blank).catch(() => {}); });
    } else if (row.type === "search") {
      runSearch(row.engine, row.query);
    } else if (row.type === "engine") {
      input.value = "";
      setMode(row.engine);
    } else if (row.type === "native") {
      const id = targetTab;
      close(false);
      nativeEntry(row.text, { tabId: id, submit: false });
    } else if (row.type === "pick") {
      close(true);
      Promise.resolve().then(() => row.run()).catch((e) => console.warn("[vivarc] pick:", e));
    } else if (row.type === "action" && row.action.stay) {
      input.value = "";
      typed = "";
      Promise.resolve().then(() => row.action.run(row.tab)).catch((e) => console.warn("[vivarc] action:", e));
    } else if (row.type === "action") {
      close(true);
      Promise.resolve().then(() => row.action.run(row.tab)).catch((e) => console.warn("[vivarc] action:", e));
    } else {
      go(row.url);
    }
  };

  const render = () => {
    if (!list) return;
    list.replaceChildren(...rows.map((row, i) => {
      const item = el("div", `vm-cmd-row${i === selected ? " sel" : ""}`);
      if (row.type === "action" || row.type === "engine" || row.type === "pick" || row.type === "native") {
        const glyph = el("span", "vm-cmd-ico vm-cmd-glyph");
        glyph.innerHTML = ACTION_SVG;
        item.append(glyph, el("span", "vm-cmd-title", row.label));
        if (row.sub) item.append(el("span", "vm-cmd-sub", `— ${row.sub}`));
      } else if (row.type === "search" || row.type === "suggest") {
        const glyph = el("span", "vm-cmd-ico vm-cmd-glyph");
        glyph.innerHTML = SEARCH_SVG;
        item.append(glyph, el("span", "vm-cmd-title", row.label));
      } else {
        item.append(iconFor(row.url, row.favicon), el("span", "vm-cmd-title", row.label));
        if (row.sub) item.append(el("span", "vm-cmd-sub", `— ${row.sub}`));
      }
      const says = { tab: "Switch to Tab", action: "Run Action", engine: "Tab", url: "Go to URL", pick: "Choose", native: "Vivaldi" }[row.type] ||
        (row.lead ? "Search" : null);
      if (says) {
        const hint = el("span", "vm-cmd-hint");
        hint.append(el("span", null, says));
        const arrow = el("span", "vm-cmd-arrow");
        arrow.innerHTML = ARROW_SVG;
        hint.append(arrow);
        item.append(hint);
      }
      item.addEventListener("mousemove", () => {
        if (selected === i) return;
        selected = i;
        list.querySelector(".sel")?.classList.remove("sel");
        item.classList.add("sel");
      });
      item.addEventListener("click", () => run(row));
      return item;
    }));
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  };

  const allTabs = async () =>
    (window.__vm.peek?.without ?? ((tabs) => tabs))(await chrome.tabs.query({ currentWindow: true })).filter((t) => !isBlank(t) && t.id !== targetTab);

  // The list with nothing typed (Byron, 2026-11-15; workspaces.barTabs): this window's ordinary tabs of the space on
  // screen here, most recently used first (lastAccessed), up to 50, the list scrolling past what fits. Left out: other
  // windows and spaces, favorites' and pins' tabs and Vivaldi-pinned tabs (workspaces.heldTabs, shared with the Ctrl+Tab
  // switcher), blank tabs, the bar's own tab and the active one (switching to the tab you are on does nothing).
  // The space on screen is Vivaldi's record for this window, as the sidebar reads it, else the active tab's. Only a
  // space known to exist lists anything (Task 9a: the first row is what Enter picks). Typing still searches every tab.
  const recentTabs = async () => {
    const spaces = window.__vm.workspaces;
    const [win, tabs, [active], ids] = await Promise.all([chrome.windows.getCurrent().catch(() => null),
      chrome.tabs.query({ currentWindow: true }).catch(() => []), chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
      Promise.resolve(window.__vm.native?.spaceIds?.()).catch(() => null)]);
    const here = win?.id ?? active?.windowId;
    let shown = null;
    try { shown = here != null ? window.__vm.native?.record?.()?.activeIn(here) ?? null : null; } catch (_) {}
    if (shown == null) shown = active && active.windowId === here ? spaces.of(active) : null;
    if (shown == null) return [];
    const bound = spaces.heldTabs();
    const mine = (window.__vm.peek?.without ?? ((t) => t))(tabs).filter((t) => !isBlank(t));
    return spaces.barTabs({ tabs: mine, here, shown, known: spaces.spaceList(ids), bound, skip: [targetTab, active?.id] });
  };

  const pageBehindBar = async () => {
    if (editing !== null) return chrome.tabs.get(targetTab).catch(() => null);
    if (keepTarget) return null; // an empty space: nothing behind the bar, and the last page is in another space
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && !isBlank(active) && active.id !== targetTab) return active;
    const last = activeHistory.filter((id) => id !== targetTab).pop();
    return last != null ? chrome.tabs.get(last).catch(() => null) : null;
  };

  const matchingActions = async (needle) => {
    const hits = ACTIONS.filter((a) => `${a.label} ${a.words}`.toLowerCase().split(/\s+/)
      .some((w) => w.startsWith(needle)) || a.label.toLowerCase().includes(needle));
    if (!hits.length) return [];
    const tab = hits.some((a) => a.tab) ? await pageBehindBar() : null;
    return hits.filter((a) => (!a.tab || tab) && (!a.when || a.when(tab))).slice(0, 3)
      .map((action) => ({ type: "action", action, tab, label: action.label }));
  };

  // The rows that lead for typed text, known without any lookup: its engine (a keyword), its address, and its search, read
  // the way Vivaldi's own field reads them (search.resolve, 08-search.js: localhost and ports, IPv4 and IPv6, an intranet
  // name with a path or port, file:, about:, view-source:, chrome:, vivaldi:, data:, other schemes). A bare word that could
  // be an intranet name is a search first, its address second, as in Vivaldi. javascript: leads to Vivaldi's own field.
  // `native` is the escape hatch, the last row whenever something is typed.
  const leadRows = (text) => {
    const meant = search.resolve?.(text, { editing }) || null;
    const keyword = !/\s/.test(text) && engines.find((en) => en.keyword.toLowerCase() === text.toLowerCase());
    const native = text ? { type: "native", text, label: "Open in Vivaldi's address field" } : null;
    return {
      engine: keyword ? { type: "engine", engine: keyword, label: `Search ${keyword.name}` } : null,
      url: meant?.kind === "url" ? { type: "url", url: meant.url, label: text } : null,
      alt: meant?.alt ? { type: "url", url: meant.alt, label: meant.alt } : null,
      search: meant?.kind === "native" ? null : { type: "search", engine: DEFAULT, query: text, label: text, lead: true },
      nativeLead: meant?.kind === "native" ? native : null,
      native,
    };
  };
  // Shown as soon as the text changes: tab, bookmark and history lookups can take seconds, and until they answer the
  // rows would still be those for the text before, which Enter would run.
  const showLeadRows = () => {
    if (mode) return;
    const text = input.value.trim();
    const lead = leadRows(text);
    rows = text ? [lead.engine, lead.nativeLead, lead.url, lead.search, lead.alt, lead.nativeLead ? null : lead.native].filter(Boolean) : [];
    selected = 0;
    render();
  };

  const compute = async () => {
    const id = ++seq;
    perf.computeStarted++;
    const text = input.value.trim();
    const out = [];
    if (mode?.pick) {
      out.push(...mode.pick(text).map((p) => ({ type: "pick", ...p })));
    } else if (mode) {
      out.push({ type: "search", engine: mode, query: text, label: text || "%s", lead: true });
    } else if (!text) {
      (await recentTabs()).forEach((tab) =>
        out.push({ type: "tab", tab, url: tab.url, favicon: tab.favIconUrl, label: window.__vm.workspaces.startTitle(tab) || tab.title || tab.url }));
    } else {
      const needle = text.toLowerCase();
      const seen = new Set();
      const matches = [];
      const add = (row) => {
        const key = row.url.replace(/#.*$/, "");
        if (seen.has(key)) return;
        seen.add(key);
        matches.push(row);
      };
      const tabsNow = await allTabs();
      if (id !== seq) { perf.computeDropped++; return false; } // newer text: this one's lookups stop here
      tabsNow
        .filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(needle))
        .slice(0, 4)
        .forEach((tab) => add({ type: "tab", tab, url: tab.url, favicon: tab.favIconUrl, label: window.__vm.workspaces.startTitle(tab) || tab.title || tab.url }));
      try {
        if (id !== seq) { perf.computeDropped++; return false; }
        (await chrome.bookmarks.search(text)).filter((b) => b.url).slice(0, 3)
          .forEach((b) => add({ type: "bookmark", url: b.url, label: b.title || b.url, sub: hostOf(b.url) }));
      } catch (_) {}
      try {
        if (id !== seq) { perf.computeDropped++; return false; }
        (await chrome.history.search({ text, maxResults: 4 }))
          .forEach((h) => add({ type: "history", url: h.url, favicon: null, label: h.title || h.url, sub: hostOf(h.url) }));
      } catch (_) {}
      if (id !== seq) return;
      // A tab whose space was deleted never leads (Enter would run it; task 8y): it is still listed, and picking it brings it here.
      const known = window.__vm.workspaces.spaceList(await window.__vm.native?.spaceIds?.());
      const prefix = matches.find((m) => hostOf(m.url).startsWith(needle) && !(m.type === "tab" && !window.__vm.workspaces.liveSpace(m.tab, known)));
      const lead = leadRows(text);
      if (lead.nativeLead) out.push(lead.nativeLead);
      if (lead.url) out.push(lead.url);
      if (prefix) out.push(prefix);
      if (lead.search) out.push(lead.search);
      if (needle.length > 1) out.push(...await matchingActions(needle));
      if (lead.engine) out.unshift(lead.engine);
      out.push(...matches.filter((m) => m !== prefix));
      // Address-shaped text (an address, an intranet name with a path, a malformed one) never goes to the suggestion service.
      if (window.__vm.settings.get("searchSuggestions") && !lead.url && lead.search && text.length > 1 && !search.addressShaped?.(text) && id === seq) {
        try {
          const engine = await search.defaultEngine();
          const phrases = await search.suggestions(engine, text);
          if (id !== seq) return;
          phrases.filter((p) => p && p.toLowerCase() !== needle).slice(0, 4)
            .forEach((p) => out.push(suggestionRow(p)));
        } catch (_) {}
      }
    }
    if (id !== seq) return false;
    // Last: a bare word's intranet address (after the actions and pages it may also name), then the escape hatch.
    if (!mode && text) {
      const lead = leadRows(text);
      if (lead.alt && !out.some((r) => r.type === "url" && r.url === lead.alt.url)) out.push(lead.alt);
      if (!out.some((r) => r.type === "native")) out.push(lead.native);
    }
    // A row picked with the arrow keys while the lookups ran stays picked.
    const picked = selected > 0 ? rows[selected] : null;
    rows = out.map((r) => (r.type === "suggest" ? { ...r, type: "search" } : r));
    const same = (r) => r.type === picked.type && r.url === picked.url && r.query === picked.query && r.engine === picked.engine;
    selected = picked ? Math.max(0, rows.findIndex(same)) : 0;
    render();
    if (picked && selected === 0) fill(); // the picked row is gone: the field shows what was typed again (#129)
    return true; // these rows are for the text in the bar
  };

  const setMode = (engine) => {
    mode = engine;
    chipHolder.replaceChildren();
    if (engine) {
      const chip = el("span", "vm-cmd-chip", engine.name);
      chip.style.backgroundColor = CHIP_COLORS[engine.keyword] || "#5b5670";
      chipHolder.append(chip);
    }
    input.placeholder = engine?.placeholder || (engine ? "Search…" : "Search or Enter URL…");
    input.value = "";
    typed = "";
    compute().catch((error) => console.warn("[vivarc] command bar rows:", error));
  };

  const autocomplete = async () => {
    if (!input) return; // Enter closed the bar first
    const text = input.value;
    if (mode || !text || /\s/.test(text) || !autoCompleted || selected > 0) return;
    const needle = text.toLowerCase();
    const known = window.__vm.workspaces.spaceList(await window.__vm.native?.spaceIds?.());
    const hosts = [
      ...(window.__vm.peek?.without ?? ((tabs) => tabs))(await chrome.tabs.query({ currentWindow: true })).filter((t) => window.__vm.workspaces.liveSpace(t, known)).map((t) => hostOf(t.url)),
      ...((await chrome.bookmarks.search(text).catch(() => [])).map((b) => hostOf(b.url))),
    ];
    const host = hosts.find((h) => h && h.startsWith(needle) && h.length > needle.length);
    if (host && input?.value === text) {
      input.value = host;
      input.setSelectionRange(text.length, host.length);
    }
  };

  // Ported from KASOGIT/vivarc#129: the row picked with the arrow keys fills the field, Arc-style. Its text (an address
  // without its scheme, a search's words) completes what was typed, the rest selected, so typing on replaces the rest; text
  // that does not start with what was typed takes the field whole. Back on the first row, the field is what was typed. Only
  // the arrows fill it (not the mouse), and Enter still runs the row itself.
  const fillText = (row) => {
    if (!row || mode) return null;
    if (row.type === "search") return row.query || null;
    if (row.url && ["tab", "bookmark", "history", "url"].includes(row.type)) return row.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return null;
  };
  const fill = () => {
    if (!input || mode) return;
    const text = selected > 0 ? fillText(rows[selected]) : null;
    if (!text) { if (input.value !== typed) input.value = typed; return; }
    if (typed && text.toLowerCase().startsWith(typed.toLowerCase())) {
      input.value = typed + text.slice(typed.length);
      input.setSelectionRange?.(typed.length, input.value.length);
    } else {
      input.value = text;
      input.setSelectionRange?.(text.length, text.length);
    }
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      selected = (selected + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      render();
      fill();
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); run(rows[selected]); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const keyword = input.value.trim().toLowerCase();
      const engine = !e.shiftKey && !mode && keyword && engines.find((en) => en.keyword.toLowerCase() === keyword);
      if (engine) { setMode(engine); return; }
      // Otherwise Tab goes into the fly-up (its first button; Shift+Tab its last), which holds the page's questions and
      // actions; inside it Tab moves on and comes back to the input at either end (flyKeys), Escape comes back too.
      const items = flyButtons();
      if (items.length) (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      return;
    }
    if (e.key === "Backspace" && mode && !input.value) { e.preventDefault(); setMode(null); return; }
    autoCompleted = e.key.length === 1 && !e.metaKey && !e.ctrlKey;
  };

  const flyButtons = () => [...(bar?.querySelectorAll(".vm-cmd-fly button:not(:disabled)") || [])].filter((b) => b.getClientRects().length);
  const flyKeys = (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); input?.focus(); return; }
    if (e.key !== "Tab") return;
    const items = flyButtons();
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const next = at + (e.shiftKey ? -1 : 1);
    if (next < 0 || next >= items.length) input?.focus();
    else items[next].focus();
  };
  let flyObserver = null;

  // `text` (with `keep`) edits the target tab's own URL: the bar opens filled in with it, selected.
  const open = async (tabId, tabWindowId, keep = false, text = null) => {
    if (!window.__vm.cssLoaded || window.__vm.settings.isOpen?.()) return false;
    try {
      const win = await chrome.windows.getCurrent();
      const kind = win.vivExtData ? JSON.parse(win.vivExtData).windowType : null;
      if (win.type !== "normal" || (kind && kind !== "normal") || win.focused === false ||
          (tabWindowId != null && tabWindowId !== win.id)) return false;
    } catch (error) {
      console.warn('[vivarc] cannot determine command bar window:', error);
      return false;
    }
    if (!window.__vm.cssLoaded || window.__vm.settings.isOpen?.()) return false;
    if (bar && keep) return false; // an empty space's open never takes over a bar the user opened
    if (bar) {
      const wasEditing = editing !== null;
      targetTab = tabId;
      keepTarget = false;
      editing = null;
      if (wasEditing) { input.value = ""; compute().catch((error) => console.warn("[vivarc] command bar rows:", error)); } // the edited address is not the new tab's
      return true;
    }
    targetTab = tabId;
    keepTarget = keep;
    editing = keep && text != null ? text : null;
    openedAt = Date.now();
    mode = null;
    bar = el("div");
    bar.id = "vm-cmd";
    const box = el("div", "vm-cmd-box");
    const head = el("div", "vm-cmd-head");
    const glyph = el("span", "vm-cmd-glyph");
    glyph.innerHTML = SEARCH_SVG;
    chipHolder = el("span", "vm-cmd-chips");
    input = el("input");
    input.placeholder = "Search or Enter URL…";
    input.spellcheck = false;
    input.autocomplete = "off";
    head.append(glyph, chipHolder, input);
    list = el("div", "vm-cmd-list");
    box.append(head, list);
    // The fly-up (17-notify.js) sits right above the input: the tab's questions, messages, indicators and page actions.
    const stack = el("div", "vm-cmd-stack");
    const fly = el("div", "vm-cmd-fly");
    fly.hidden = true;
    stack.append(fly, box);
    bar.append(stack);
    // A click just after opening is the rest of a double or triple click that opened it, not a click away.
    // Ported from KASOGIT/vivarc#119 (a2f77c2): a click outside the bar closes it and still reaches the sidebar item it was
    // on (a tab, a pinned row, a tile, a space), instead of taking two clicks. The press closed the bar, so the item gets
    // the click when the button comes up over the same item.
    const PASS = "#vm-panel .vm-row, #vm-panel .vm-fav, #vm-panel .vm-space-pill";
    bar.addEventListener("mousedown", (e) => {
      if (e.target !== bar || Date.now() - openedAt <= 500) return;
      close(true);
      if (e.button !== 0) return;
      const through = (up) => {
        try {
          // What is under the pointer gets the click a real one would give it (a row's own button, a chevron), as long as
          // the press and the release were on the same sidebar item.
          const at = document.elementFromPoint(up.clientX, up.clientY);
          const target = at?.closest?.(PASS);
          if (target && target === document.elementFromPoint(e.clientX, e.clientY)?.closest?.(PASS)) {
            at.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0, detail: 1, clientX: up.clientX, clientY: up.clientY,
              ctrlKey: up.ctrlKey, metaKey: up.metaKey, shiftKey: up.shiftKey, altKey: up.altKey }));
          }
        } catch (error) { console.warn("[vivarc] click through:", error); }
      };
      document.addEventListener("mouseup", through, { once: true, capture: true });
      setTimeout(() => document.removeEventListener("mouseup", through, true), 1500); // released outside the window: no late click
    });
    fly.addEventListener("keydown", flyKeys);
    flyObserver?.disconnect();
    flyObserver = null;
    if (typeof ResizeObserver === "function") {
      flyObserver = new ResizeObserver(() => { bar?.style.setProperty("--vm-fly-h", fly.hidden ? "0px" : `${Math.ceil(fly.getBoundingClientRect().height) + 8}px`); });
      flyObserver.observe(fly);
    }
    input.addEventListener("keydown", onKey);
    // Only the latest text is completed inline: an older keystroke's lookups would complete the text typed since.
    input.addEventListener("input", async () => {
      try {
        typed = input.value;
        showLeadRows();
        if (await compute()) await autocomplete();
      } catch (error) { console.warn("[vivarc] command bar rows:", error); }
    });
    if (editing !== null) input.value = editing;
    typed = input.value;
    (document.querySelector("#browser") || document.body).append(bar);
    const filled = input.value;
    const focus = () => {
      if (!input || document.activeElement === input) return;
      input.focus();
      if (filled && input.value === filled) input.select(); // the whole URL, until it is changed
    };
    focus();
    setTimeout(focus, 60);
    setTimeout(focus, 250);
    showLeadRows(); // an address filled in for editing: Enter acts on it before the lookups answer
    compute().catch((error) => console.warn("[vivarc] command bar rows:", error));
    try {
      // The bar's tab: the page it edits, its own blank tab, or (Ctrl+T's bar, which has no tab) the page behind it. The
      // page's rows show whenever that is a page: not over a blank tab or a private window's introduction.
      window.__vm.notify?.barOpened({ fly, close: () => close(true), tab: () => targetTab ?? null, // null (Ctrl+T's bar): the active tab
        rows: () => editing !== null || targetTab == null });
    } catch (error) { console.warn("[vivarc] fly-up:", error); }
    window.dispatchEvent(new CustomEvent("vm-command-bar", { detail: { open: true } }));
    // Like Arc, a new tab scrolls the sidebar to the new-tab area; editing the current page leaves it where it is.
    if (editing === null) window.dispatchEvent(new CustomEvent("vm-command-bar-opened"));
    return true;
  };

  const opened = (promise) => Promise.resolve(promise).catch((error) => { console.warn("[vivarc] command bar:", error); return false; });
  window.addEventListener("vm-open-command-bar", () => opened(open(null)));
  // The sidebar's URL field: edit the current page's address in the bar, as Arc's Cmd+L does.
  // A blank tab or a private window's introduction page opens the bar empty (startsEmpty), on every path.
  window.addEventListener("vm-edit-url", async () => {
    asked(); // the user asked to edit the address: no tab switch just before it may send the cursor to the page
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (!active) return opened(open(null));
    return opened(open(active.id, active.windowId, true, startsEmpty(active) ? null : active.pendingUrl || active.url || ""));
  });
  // A window starting on a new tab (launch, Ctrl+N): Vivaldi puts the cursor in its hidden address bar, which then
  // floats over the sidebar. Open the bar on that tab instead, as a new tab does. It keeps the tab: often the window's
  // only one, and closing it would close the window.
  // Until that is settled, the vm-launching marker holds Vivaldi's address bar collapsed even when focused (vivarc.css),
  // so it never shows; once the bar has the cursor, or there is no bar to open, the marker goes.
  let launching = true;
  let marked = null;
  window.__vm.onMark?.((browser) => { marked = browser; if (launching) browser.classList.add("vm-launching"); });
  const launched = () => { launching = false; marked?.classList.remove("vm-launching"); };
  Promise.resolve(window.__vm.ready).then(async (cssLoaded) => {
    if (!cssLoaded) return false;
    await new Promise((resolve) => setTimeout(resolve, 300)); // let Vivaldi finish opening the window
    // Vivaldi put the cursor in its field before the stylesheet was confirmed (measured: within ~150 ms of the window, the
    // guard below not yet on): it leaves the field now, so nothing types into a field that does not show.
    const field = document.getElementById?.("urlFieldInput");
    if (ownsField && field && document.activeElement === field) { field.blur(); unscroll(field); }
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    return !!(active && startsEmpty(active) && !bar && await open(active.id, active.windowId, true));
  }).catch((error) => {
    console.warn("[vivarc] launch bar:", error);
    return false;
  }).then((opened) => (opened ? setTimeout(launched, 400) : launched())); // 400ms: past the bar's last focus retry
  window.__vm.onShortcut((key) => { if (key === window.__vm.normalise(window.__vm.shortcut("meta+t"))) opened(open(null)); });

  // Landing in an empty space, from the space bar, a shortcut or Vivaldi's own menu, opens the bar on the space's blank
  // tab, as a new tab does; the bar keeps that tab, so Escape stays in the space. A bar still open from the space just
  // left is closed first: it belongs to that space's tab. Every window sees every window's tab events, so only a switch
  // in this window, between two tabs of this window, counts.
  const spaceChanged = async (previous, tabId, windowId) => {
    const spaceOf = window.__vm.workspaces?.of;
    if (!spaceOf || Date.now() - startedAt < 5000) return;
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (!win || win.id !== windowId) return;
    await new Promise((resolve) => setTimeout(resolve, 150)); // let Vivaldi finish switching, then look
    const [[active], prior] = await Promise.all([
      chrome.tabs.query({ active: true, windowId }).catch(() => []), chrome.tabs.get(previous).catch(() => null)]);
    if (!active || !prior || active.id !== tabId || spaceOf(active) === spaceOf(prior)) return;
    if (bar && targetTab !== tabId) close(true);
    if (bar || !isBlank(active)) return;
    const own = (await chrome.tabs.query({ windowId }).catch(() => [])).filter((t) => spaceOf(t) === spaceOf(active));
    if (own.every(isBlank)) opened(open(tabId, windowId, true));
  };

  // The address field must not pop open on a tab switch (the handler is at the end of this file). Its state: Vivaldi
  // focuses the field of a tab left with the cursor there, a few ms after that tab is activated in this window.
  let myWindow = null;
  chrome.windows.getCurrent().then((win) => { myWindow = win.id; }, () => {});
  let activation = { at: -Infinity, tabId: null, tab: null, handled: false };
  // The user's request for the field and this window's activations, in the order they happened (07-workspaces.js).
  const intent = window.__vm.workspaces.focusIntent();
  const asked = () => intent.asked(Date.now()); // Ctrl+L, Cmd+L, F6, a click on the field, the edit-URL action
  const noteActivation = (tabId, windowId) => { // the newest activation in this window, its tab already on the way
    try {
      if (myWindow == null || windowId !== myWindow) return;
      intent.activated(); // a request made before this switch is not one for the tab it switched to
      activation = { at: Date.now(), tabId, tab: Promise.resolve(chrome.tabs.get(tabId)).catch(() => null), handled: false };
    } catch (_) {}
  };
  const activeHistory = [];
  const lastActive = new Map(); // window id -> its active tab, seeded so the first switch after start counts
  chrome.tabs.query({ active: true }).then((tabs) => {
    for (const t of tabs) if (!lastActive.has(t.windowId)) lastActive.set(t.windowId, t.id);
  }, () => {});
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    noteActivation(tabId, windowId);
    activeHistory.push(tabId);
    if (activeHistory.length > 6) activeHistory.shift();
    const previous = lastActive.get(windowId);
    lastActive.set(windowId, tabId);
    if (previous != null && previous !== tabId) {
      spaceChanged(previous, tabId, windowId).catch((e) => console.warn("[vivarc] empty space:", e));
    }
    // An edit bar belongs to its page: leaving that page in this window (Ctrl+Tab...) closes it, keeping the page.
    if (editing !== null && tabId !== targetTab) {
      const edited = targetTab;
      chrome.windows.getCurrent().then((win) => {
        if (win.id === windowId && editing !== null && targetTab === edited) close(true);
      }, () => {});
    }
  });

  chrome.tabs.onCreated.addListener(async (tab) => {
    lastUrl.set(tab.id, tab.pendingUrl || tab.url || ""); // the start page mark's memory (below)
    if (handing) return; // a tab made to hand an entry to Vivaldi's own field (nativeFieldEntry)
    if ((creating && window.__vm.workspaces.startTyped(tab.pendingUrl || tab.url)) || Date.now() - startedAt < 5000 || !isBlank(tab) || tab.active === false) return;
    const previous = activeHistory.filter((id) => id !== tab.id).pop();
    // Creating/switching to an empty workspace creates its first blank tab.
    // Re-activating the previous tab here would switch straight back out of it.
    const workspaceOf = (value) => {
      try { return Number(JSON.parse(value.vivExtData || "{}").workspaceId) || 0; }
      catch (_) { return 0; }
    };
    if (previous != null) {
      const prior = await chrome.tabs.get(previous).catch(() => null);
      if (!prior || workspaceOf(prior) !== workspaceOf(tab)) return;
    } else if (workspaceOf(tab)) return;
    if (!(await opened(open(tab.id, tab.windowId)))) return;
    if (previous != null) {
      setTimeout(() => {
        if (bar && targetTab === tab.id) {
          chrome.tabs.update(previous, { active: true }).then(() => input?.focus(), () => {});
        }
      }, 120);
    }
  });
  // The start page mark follows the tab. Navigating out of the start page's family clears it (the tab is a page again,
  // and a later blank tab gets the bar). The address typed into Vivaldi's own field (not through the bar) is a user's
  // choice too: a tab of this window that goes from a page to the start page is marked. A tab that opens on the start
  // page by itself (a new tab) has no page before it, so it stays blank.
  const lastUrl = new Map(); // this window's tab id -> its last address seen
  chrome.tabs.query({ currentWindow: true }).then((tabs) => { for (const t of tabs) lastUrl.set(t.id, t.pendingUrl || t.url || ""); }, () => {});
  chrome.tabs.onRemoved?.addListener((id) => { lastUrl.delete(id); keepInPlace.delete(id); });
  chrome.windows?.onRemoved?.addListener?.((id) => { lastActive.delete(id); });
  chrome.tabs.onUpdated?.addListener((id, change, tab) => {
    try {
      if (!change?.url || myWindow == null || tab?.windowId !== myWindow) return;
      const spaces = window.__vm.workspaces;
      const before = lastUrl.get(id);
      lastUrl.set(id, change.url);
      if (spaces.startWanted(tab)) {
        if (!spaces.inStartFamily(change.url)) setExtData(tab, { [spaces.START_KEY]: null }).catch((e) => console.warn("[vivarc] start page mark:", e));
      } else if (before && !spaces.inStartFamily(before) && spaces.isBlankUrl(change.url)) {
        markStart(id).catch((e) => console.warn("[vivarc] start page mark:", e));
      }
    } catch (error) {
      console.warn("[vivarc] start page mark:", error);
    }
  });

  // The command bar replaces Vivaldi's address field for typing (Task 9b). Whenever the field would take the cursor (Ctrl+L,
  // F6, Alt+D: 12-sidebar-hide.js takes those first where it can; Vivaldi focusing it on a new tab, a tab switch or a new
  // window; anything else), the cursor leaves it at once and the bar opens instead: editing the page's address, or empty on
  // a blank tab or a private window's introduction page. The field itself never shows (vivarc.css), and its
  // popups drop from where Vivarc's toasts do (17-notify.js). Only in a window the bar can open in (a normal window): a
  // popup or settings window keeps Vivaldi's field.
  // Task 8o's rule stays for a focus nobody asked for just after a tab switch: Vivaldi remembers per tab where the cursor was,
  // and putting it back in the field on every return would open the bar on every switch, so the page gets it instead
  // (webview.focus(), as Vivaldi gives it when it has no such memory; Vivaldi then records "page" for the tab).
  // Measured on 8.3 (task 9b): the field, 348 px wide in a 323 px sidebar, made Chromium scroll #tabs-container sideways
  // when it took the cursor floated (the whole sidebar moved left, Byron's private-window bug); vivarc.css clips that
  // container (overflow: clip, no scrolling at all), and the guard puts any scroll it finds back to 0.
  const ASKED_MS = 1500; // a Ctrl+L, F6 or click on the field this recently is the user asking for it
  // (State: myWindow, activation, asked and noteActivation, above the tab events, which feed them.)
  const ASK_KEYS = new Set(["ctrl+l", "l+meta", "f6", "alt+d"].map((k) => window.__vm.normalise(k)));
  window.__vm.onShortcut((key) => { if (ASK_KEYS.has(key) && asks(key)) asked(); }); // asks: below (a key rebound to a tab switch)
  // Any key Vivaldi handles as a shortcut in this window (a custom "focus address field" binding included), and a press in
  // Vivaldi's own menus, is the user asking: a focus that follows it is a command, not a tab's remembered focus coming back
  // (which stays Task 8o's page focus, the controller's ruling).
  // A tab-switching shortcut (Ctrl+Tab, Ctrl+PgDn, Ctrl+1, Ctrl+W...) is never one: it is what moves the cursor (review
  // round 3). Vivaldi's keyboard table is read live, its defaults until then (07-workspaces.js addressKeys).
  let asks = window.__vm.workspaces.addressKeys(null, window.__vm.normalise);
  const readKeys = () => Promise.resolve(vivaldi.prefs.get("vivaldi.actions")).then((pref) => {
    asks = window.__vm.workspaces.addressKeys(pref?.value?.[0], window.__vm.normalise);
  }).catch(() => {});
  try { readKeys(); vivaldi.prefs.onChanged?.addListener((path) => { if (path === "vivaldi.actions") readKeys(); }); } catch (_) {}
  window.__vm.onShortcut((key, _combo, pressedIn) => {
    const own = window.vivaldiWindowId;
    if ((typeof pressedIn !== "number" || typeof own !== "number" || pressedIn === own) && asks(key)) asked();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!window.__vm.synthetic?.(e) && e.isTrusted && e.target?.closest?.(".vivaldi-menu, .menu, [role=menu], [role=menuitem], button.vivaldi, .context-menu")) asked();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "F6" || ((e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === "l") || (e.altKey && e.key?.toLowerCase() === "d")) asked();
  }, true);
  document.addEventListener("pointerdown", (e) => { if (!window.__vm.synthetic?.(e) && e.target?.closest?.(".UrlBar-AddressField")) asked(); }, true);
  // Whether this window's field is the bar's (a normal window), known once the window is read.
  let ownsField = false;
  chrome.windows.getCurrent().then((win) => {
    let kind = "normal";
    try { kind = JSON.parse(win.vivExtData || "{}").windowType || "normal"; } catch (_) {}
    ownsField = win.type === "normal" && kind === "normal";
  }, () => {});
  const unscroll = (field) => {
    for (let e = field.parentElement; e && e !== document.body; e = e.parentElement) {
      if (e.scrollLeft) e.scrollLeft = 0;
      if (e.scrollTop && e.matches?.("#tabs-container, #tabs-tabbar-container, .toolbar-tabbar-before")) e.scrollTop = 0;
      if (e.id === "browser") break;
    }
  };
  // Vivaldi focuses its field from many places: Ctrl+L and its other keys, its menu's and its own custom shortcuts' "focus
  // the address field" commands, a new tab or window (also in a window's first seconds), a tab switch back to a tab left
  // with the cursor there. The field never takes it (vivarc.css keeps it visibility: hidden, so a plain focus() would do
  // nothing at all): Vivarc's own focus() of HTMLElement sees every one of those calls on the field and routes it here.
  // - Vivarc's own synthetic press (a re-opened question's popup), a popup of the field that is up (Vivaldi putting the
  //   cursor back after it), or the field being used for one entry (the escape hatch, above): Vivaldi's own focus.
  // - A focus nobody asked for within 150 ms of a tab switch to a page: the page keeps the cursor (Task 8o, Byron: "a tab
  //   switch must not pop the address field open").
  // - The bar already open: its input gets the cursor.
  // - Otherwise the bar: empty on a blank tab or a private window's introduction page (keeping the tab when it is all its
  //   space has, else Esc closes it like Ctrl+T's), editing the address on a page. While a window starts, its launch code
  //   (above) decides.
  const focusOf = (node) => (origFocus ? origFocus.call(node) : node.focus());
  const popupUp = () => !!document.querySelector("#tabs-tabbar-container .UrlBar-AddressField :is(.addressfield-popup-container:not(.vm-site-carded), .button-popup:not(.vm-site-carded))");
  const takesField = (node) => !nativeOpen && !handing && ownsField && !!window.__vm.cssLoaded && node?.id === "urlFieldInput" &&
    !!node.closest?.("#tabs-tabbar-container .UrlBar-AddressField") && !!document.querySelector("#browser.vm-on");
  let pendingOpen = null; // a bar this route is opening: one more request waits for it instead of opening another
  // -> a promise that settles when the bar next says it opened (vm-command-bar), or after ms: either way its listener goes,
  // so a declined open never leaves one behind (final review, Codex minor).
  const barOpened = (ms) => new Promise((resolve) => {
    let t = null;
    const end = () => { clearTimeout(t); window.removeEventListener("vm-command-bar", end); resolve(); };
    t = setTimeout(end, ms);
    window.addEventListener("vm-command-bar", end);
  });
  const route = async (field) => {
    perf.fieldRoutes++;
    const sinceActivation = Date.now() - activation.at;
    const current = activation;
    // Asked after the last tab switch, by order not by clock: a command (Ctrl+L, a custom binding, a menu). A request
    // before the switch was forgotten by it, so the focus that follows the switch is the tab's remembered one: passive.
    const userAsked = intent.userAsked(Date.now(), ASKED_MS);
    unscroll(field);
    if (bar) { input?.focus(); return; }
    if (launching) return; // the launch code opens the bar on a blank tab or a private window's intro page
    const give = window.__vm.workspaces?.returnFocus;
    const tab = !current.handled && sinceActivation <= window.__vm.workspaces.RETURN_FOCUS_MS ? await current.tab : null;
    if (give && tab && current === activation && tab.active !== false && !startsEmpty(tab) && give({
      msSinceActivation: sinceActivation,
      userAsked,
      edited: nativeOpen, // the field holds an entry being typed (the escape hatch): never taken from it
      popupOpen: popupUp(),
    })) {
      const view = document.getElementById(String(tab.id));
      if (view?.tagName === "WEBVIEW") { current.handled = true; view.focus(); }
      return;
    }
    if (bar) { input?.focus(); return; }
    if (pendingOpen) { await pendingOpen; input?.focus(); return; }
    pendingOpen = (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (!active || bar) return;
      if (!startsEmpty(active)) {
        const done = barOpened(1500);
        window.dispatchEvent(new CustomEvent("vm-edit-url"));
        await done;
        return;
      }
      const spaceOf = window.__vm.workspaces?.of;
      const own = spaceOf ? (await chrome.tabs.query({ windowId: active.windowId }).catch(() => [])).filter((t) => spaceOf(t) === spaceOf(active)) : [active];
      await opened(open(active.id, active.windowId, own.every(startsEmpty)));
    })();
    try { await pendingOpen; } finally { pendingOpen = null; }
  };
  const fieldAsked = (field) => {
    if (window.__vm.synthNow || popupUp()) return false; // Vivaldi's own focus stands
    route(field).catch((error) => console.warn("[vivarc] address field to the command bar:", error));
    return true;
  };
  const origFocus = typeof HTMLElement === "function" ? HTMLElement.prototype.focus : null;
  if (origFocus) {
    HTMLElement.prototype.focus = function focus(...args) {
      try { if (takesField(this) && fieldAsked(this)) return undefined; } catch (error) { console.warn("[vivarc] address field focus:", error); }
      return origFocus.apply(this, args);
    };
  }
  // A focus that still reaches the field some other way (the field shown for one entry is excluded): taken back.
  document.addEventListener("focusin", (e) => {
    try {
      const field = e.target;
      if (!takesField(field) || window.__vm.synthetic?.(e) || popupUp()) return;
      field.blur();
      requestAnimationFrame(() => unscroll(field));
      fieldAsked(field);
    } catch (error) {
      console.warn("[vivarc] address field to the command bar:", error);
    }
  }, true);
  window.__vm.onMark?.((browser) => { if (nativeOpen) browser.classList.add("vm-native-field"); });
  // barOpened, askedNow and fieldEntry are seams for search.test.cjs: fieldEntry is the field session itself, past nativeEntry's
  // check, so the test proves its own boundary (it never submits a prohibited scheme either).
  window.__vm.commandBar = { barOpened, askedNow: () => intent.userAsked(Date.now(), ASKED_MS), fieldEntry: (text, options) => nativeFieldEntry(text, options), ownsField: () => ownsField, isOpen: () => !!bar, nativeOpen: () => nativeOpen, handOver: (text, options) => nativeEntry(text, options) };
  console.log("[vivarc] command bar started");
})();
