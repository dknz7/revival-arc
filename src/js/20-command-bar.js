// Vivarc command bar. Opens whenever a blank new tab is created (Cmd+T bound to "New Tab",
// the sidebar "+ New Tab" row). The blank tab is navigated to the choice, or closed on Escape.
(() => {
  const BLANK = /^(chrome|vivaldi):\/\/(newtab|vivaldi-webui\/startpage)/;
  // Vivaldi's Bookmarks, History, Notes, Calendar and Dashboard are its start page with a section; of those, only
  // Speed Dial is a new tab.
  const SECTION = /[?&]section=(?!Speed-dials(?:[&#]|$))/i;
  const isBlank = (tab) => {
    const url = tab.pendingUrl || tab.url || "";
    return BLANK.test(url) && !SECTION.test(url);
  };
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
  const looksLikeUrl = (text) =>
    /^(https?:\/\/|chrome:\/\/|vivaldi:\/\/)/i.test(text) || (/^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(text) && !text.includes(" "));
  const toUrl = (text) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);

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
  // Show url in the bar's target tab, or in a new tab when it has none.
  const show = async (id, isNew, url) => {
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
    } },
    { label: "Add This Tab to Favorites", words: "favorite pin", tab: true, run: async (tab) => {
      if (await window.__vm.pinTab?.(tab, "Favorites")) toast("Added to Favorites");
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
    { label: "Reopen Closed Tab", words: "restore undo", run: () => chrome.sessions.restore() },
    { label: "New Window", words: "open window", run: () => chrome.windows.create({}) },
    { label: "New Private Window", words: "incognito private", run: () => chrome.windows.create({ incognito: true }) },
    { label: "Vivarc Guide", words: "welcome help shortcuts tour start", run: () => {
      const url = window.__vm.config.startUrl;
      if (url) openPage(url);
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
    bar?.remove();
    bar = input = list = chipHolder = targetTab = mode = null;
    keepTarget = false;
    editing = null;
    rows = [];
    seq++;
    if (removeBlank && blank != null && !keep) chrome.tabs.remove(blank).catch(() => {});
  };

  const go = (url) => {
    const id = targetTab;
    const isNew = editing === null && !keepInPlace.has(id);
    close(false);
    show(id, isNew, url).catch((error) => console.warn("[vivarc] open:", error));
  };

  const runSearch = async (engine, query) => {
    const id = targetTab;
    const isNew = editing === null && !keepInPlace.has(id);
    const currentInput = input;
    try {
      const chosen = engine === DEFAULT ? await search.defaultEngine() : engine;
      const request = await search.request(chosen, query);
      if (request.postParams) {
        throw new Error('This engine uses POST searches, which the command bar cannot navigate yet. Use Vivaldi?s address bar.');
      }
      if (!/^https?:\/\//i.test(request.url)) throw new Error('Invalid search URL returned by Vivaldi.');
      // Do not navigate a stale command bar after it was closed or replaced.
      if (input !== currentInput) return;
      await show(id, isNew, request.url);
      close(false);
    } catch (error) {
      console.warn('[vivarc] search failed; trying DuckDuckGo:', error);
      if (input !== currentInput || !input) return;
      try {
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
        await show(id, isNew, url);
        close(false);
        toast('Search engine unavailable. Using DuckDuckGo.');
      } catch (fallbackError) {
        console.warn('[vivarc] DuckDuckGo fallback failed:', fallbackError);
        toast('Search unavailable. Use the address bar (Ctrl+L / Cmd+L).');
      }
    }
  };

  // The bar lists every tab of the window, parked ones included. A parked tab activated as it is leaves Vivaldi's record
  // on the space shown (G1), and repair 2 would snap the window back: its space is shown first (workspaces.tabPick).
  // Without the record or the switch, the tab is activated as it always was. The bar's own blank tab is closed after,
  // so it never hands the screen to some other tab in between.
  const pickTab = async (listed) => {
    const tab = (await chrome.tabs.get(listed.id).catch(() => null)) || listed; // the list may be older than a move
    const native = window.__vm.native;
    const spaces = window.__vm.workspaces;
    const record = native?.hasSwitch() ? native.record() : null;
    const pick = record && spaces ? spaces.tabPick(tab, record.activeIn(tab.windowId), record.all().get(spaces.of(tab)) ?? null)
      : { kind: "activate" };
    if (pick.kind === "focus") return native.focus(pick.window);
    if (pick.kind === "switch") await native.switchTo(pick.window, pick.space);
    await chrome.tabs.update(tab.id, { active: true });
    // The sidebar's Open Tabs list can pick a tab of another window, which activating does not bring forward.
    const here = (await chrome.windows.getCurrent().catch(() => null))?.id;
    if (here != null && tab.windowId != null && here !== tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  };
  window.__vm.pickTab = pickTab; // shared with the sidebar's New Tab dropdown (Open Tabs, Recently Closed)

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
    } else if (row.type === "action") {
      close(true);
      Promise.resolve(row.action.run(row.tab)).catch((e) => console.warn("[vivarc] action:", e));
    } else {
      go(row.url);
    }
  };

  const render = () => {
    if (!list) return;
    list.replaceChildren(...rows.map((row, i) => {
      const item = el("div", `vm-cmd-row${i === selected ? " sel" : ""}`);
      if (row.type === "action" || row.type === "engine") {
        const glyph = el("span", "vm-cmd-ico vm-cmd-glyph");
        glyph.innerHTML = ACTION_SVG;
        item.append(glyph, el("span", "vm-cmd-title", row.label));
      } else if (row.type === "search" || row.type === "suggest") {
        const glyph = el("span", "vm-cmd-ico vm-cmd-glyph");
        glyph.innerHTML = SEARCH_SVG;
        item.append(glyph, el("span", "vm-cmd-title", row.label));
      } else {
        item.append(iconFor(row.url, row.favicon), el("span", "vm-cmd-title", row.label));
        if (row.sub) item.append(el("span", "vm-cmd-sub", `— ${row.sub}`));
      }
      const says = { tab: "Switch to Tab", action: "Run Action", engine: "Tab", url: "Go to URL" }[row.type] ||
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
    (await chrome.tabs.query({ currentWindow: true })).filter((t) => !isBlank(t) && t.id !== targetTab);

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

  // The rows that lead for typed text, known without any lookup: its engine (a keyword), its address, and its search.
  const leadRows = (text) => {
    // An edited address keeps its own scheme (file:, about:, view-source:...), which looksLikeUrl does not know.
    const scheme = editing !== null && /^[a-z][a-z0-9+.-]*:/i.exec(editing)?.[0].toLowerCase();
    const url = scheme && text.toLowerCase().startsWith(scheme) ? text : looksLikeUrl(text) ? toUrl(text) : null;
    const keyword = !/\s/.test(text) && engines.find((en) => en.keyword.toLowerCase() === text.toLowerCase());
    return {
      engine: keyword ? { type: "engine", engine: keyword, label: `Search ${keyword.name}` } : null,
      url: url ? { type: "url", url, label: text } : null,
      search: { type: "search", engine: DEFAULT, query: text, label: text, lead: true },
    };
  };
  // Shown as soon as the text changes: tab, bookmark and history lookups can take seconds, and until they answer the
  // rows would still be those for the text before, which Enter would run.
  const showLeadRows = () => {
    if (mode) return;
    const text = input.value.trim();
    const lead = leadRows(text);
    rows = text ? [lead.engine, lead.url, lead.search].filter(Boolean) : [];
    selected = 0;
    render();
  };

  const compute = async () => {
    const id = ++seq;
    const text = input.value.trim();
    const out = [];
    if (mode) {
      out.push({ type: "search", engine: mode, query: text, label: text || "%s", lead: true });
    } else if (!text) {
      (await allTabs()).slice(0, 7).forEach((tab) =>
        out.push({ type: "tab", tab, url: tab.url, favicon: tab.favIconUrl, label: tab.title || tab.url }));
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
      (await allTabs())
        .filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(needle))
        .slice(0, 4)
        .forEach((tab) => add({ type: "tab", tab, url: tab.url, favicon: tab.favIconUrl, label: tab.title || tab.url }));
      try {
        (await chrome.bookmarks.search(text)).filter((b) => b.url).slice(0, 3)
          .forEach((b) => add({ type: "bookmark", url: b.url, label: b.title || b.url, sub: hostOf(b.url) }));
      } catch (_) {}
      try {
        (await chrome.history.search({ text, maxResults: 4 }))
          .forEach((h) => add({ type: "history", url: h.url, favicon: null, label: h.title || h.url, sub: hostOf(h.url) }));
      } catch (_) {}
      if (id !== seq) return;
      const prefix = matches.find((m) => hostOf(m.url).startsWith(needle));
      const lead = leadRows(text);
      if (lead.url) out.push(lead.url);
      if (prefix) out.push(prefix);
      out.push(lead.search);
      if (needle.length > 1) out.push(...await matchingActions(needle));
      if (lead.engine) out.unshift(lead.engine);
      out.push(...matches.filter((m) => m !== prefix));
      if (window.__vm.settings.get("searchSuggestions") && !lead.url && text.length > 1) {
        try {
          const engine = await search.defaultEngine();
          const phrases = await search.suggestions(engine, text);
          if (id !== seq) return;
          phrases.filter((p) => p && p.toLowerCase() !== needle).slice(0, 4)
            .forEach((p) => out.push({ type: "suggest", engine: DEFAULT, query: p, label: p }));
        } catch (_) {}
      }
    }
    if (id !== seq) return false;
    // A row picked with the arrow keys while the lookups ran stays picked.
    const picked = selected > 0 ? rows[selected] : null;
    rows = out.map((r) => (r.type === "suggest" ? { ...r, type: "search" } : r));
    const same = (r) => r.type === picked.type && r.url === picked.url && r.query === picked.query && r.engine === picked.engine;
    selected = picked ? Math.max(0, rows.findIndex(same)) : 0;
    render();
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
    input.placeholder = engine ? "Search…" : "Search or Enter URL…";
    input.value = "";
    compute();
  };

  const autocomplete = async () => {
    if (!input) return; // Enter closed the bar first
    const text = input.value;
    if (mode || !text || /\s/.test(text) || !autoCompleted) return;
    const needle = text.toLowerCase();
    const hosts = [
      ...(await chrome.tabs.query({ currentWindow: true })).map((t) => hostOf(t.url)),
      ...((await chrome.bookmarks.search(text).catch(() => [])).map((b) => hostOf(b.url))),
    ];
    const host = hosts.find((h) => h && h.startsWith(needle) && h.length > needle.length);
    if (host && input?.value === text) {
      input.value = host;
      input.setSelectionRange(text.length, host.length);
    }
  };

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      selected = (selected + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      render();
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); run(rows[selected]); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const keyword = input.value.trim().toLowerCase();
      const engine = !mode && keyword && engines.find((en) => en.keyword.toLowerCase() === keyword);
      if (engine) setMode(engine);
      return;
    }
    if (e.key === "Backspace" && mode && !input.value) { e.preventDefault(); setMode(null); return; }
    autoCompleted = e.key.length === 1 && !e.metaKey && !e.ctrlKey;
  };

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
      if (wasEditing) { input.value = ""; compute(); } // the edited address is not the new tab's
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
    bar.append(box);
    // A click just after opening is the rest of a double or triple click that opened it, not a click away.
    bar.addEventListener("mousedown", (e) => { if (e.target === bar && Date.now() - openedAt > 500) close(true); });
    input.addEventListener("keydown", onKey);
    // Only the latest text is completed inline: an older keystroke's lookups would complete the text typed since.
    input.addEventListener("input", async () => { showLeadRows(); if (await compute()) autocomplete(); });
    if (editing !== null) input.value = editing;
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
    compute();
    // Like Arc, a new tab scrolls the sidebar to the new-tab area; editing the current page leaves it where it is.
    if (editing === null) window.dispatchEvent(new CustomEvent("vm-command-bar-opened"));
    return true;
  };

  window.addEventListener("vm-open-command-bar", () => open(null));
  // The sidebar's URL field: edit the current page's address in the bar, as Arc's Cmd+L does.
  window.addEventListener("vm-edit-url", async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (!active) return open(null);
    open(active.id, active.windowId, true, isBlank(active) ? null : active.pendingUrl || active.url || "");
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
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    return !!(active && isBlank(active) && !bar && await open(active.id, active.windowId, true));
  }).catch((error) => {
    console.warn("[vivarc] launch bar:", error);
    return false;
  }).then((opened) => (opened ? setTimeout(launched, 400) : launched())); // 400ms: past the bar's last focus retry
  window.__vm.onShortcut((key) => { if (key === window.__vm.normalise(window.__vm.shortcut("meta+t"))) open(null); });

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
    if (own.every(isBlank)) open(tabId, windowId, true);
  };

  const activeHistory = [];
  const lastActive = new Map(); // window id -> its active tab, seeded so the first switch after start counts
  chrome.tabs.query({ active: true }).then((tabs) => {
    for (const t of tabs) if (!lastActive.has(t.windowId)) lastActive.set(t.windowId, t.id);
  }, () => {});
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
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
    if (Date.now() - startedAt < 5000 || !isBlank(tab) || tab.active === false) return;
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
    if (!(await open(tab.id, tab.windowId))) return;
    if (previous != null) {
      setTimeout(() => {
        if (bar && targetTab === tab.id) {
          chrome.tabs.update(previous, { active: true }).then(() => input?.focus(), () => {});
        }
      }, 120);
    }
  });
  console.log("[vivarc] command bar started");
})();
