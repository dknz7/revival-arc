// Vivarc sidebar: favorites grid on top, then one scrollable panel (pinned folders, divider,
// open tabs). The data lives in a bookmarks folder that has a "Favorites" and a "Pinned" subfolder
// (created on first run, or produced by `vivarc import-arc`). Vivaldi's own tab strip is hidden.
(() => {
  const cfg = window.__vm.config;
  // Same blank-tab check as 20-command-bar.js (a test keeps the two equal).
  const BLANK = /^(chrome|vivaldi):\/\/(newtab|vivaldi-webui\/startpage)/;
  const SECTION = /[?&]section=(?!Speed-dials(?:[&#]|$))/i;
  const isBlankUrl = (url) => BLANK.test(url) && !SECTION.test(url);

  const store = window.__vm.store;
  const openFolders = new Set();
  const seedIcons = window.__vmIcons || {};
  let icons = {};
  const saveOpen = () => store.set("open", [...openFolders]);
  const state = { space: null, defaultSpace: null, folders: [], favs: null, pinned: null, trash: null, tabs: [], allTabs: [], bound: new Map(),
    profiles: [], renameId: null, workspaces: [], active: 0 };
  const spacesOf = window.__vm.workspaces;
  let panel = null;

  const ICON_CLOSED =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5h7A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
  const ICON_OPEN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 17.5V7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5h7A2.5 2.5 0 0 1 21 10v1.5"/><path d="M3.3 18.6 5.2 12a2 2 0 0 1 1.9-1.5H21a1 1 0 0 1 1 1.3l-1.8 6.4A2 2 0 0 1 18.3 20H5.5a2.2 2.2 0 0 1-2.2-1.4z"/></svg>';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  const pinLinks = window.__vm.pins;
  const { sameSite } = pinLinks;

  const originOf = (url) => {
    try { return new URL(url).origin; } catch (_) { return ""; }
  };

  const letterIcon = (url) => {
    let host = "?";
    try { host = new URL(url).hostname.replace(/^www\./, "") || (url.startsWith("file:") ? "vivarc" : "?"); } catch (_) {}
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    const span = el("span", "vm-letter", host[0].toUpperCase());
    span.style.backgroundColor = `hsl(${hash} 38% 40%)`;
    return span;
  };

  const iconEl = (url, live) => {
    const wrap = el("span", "vm-ico");
    const origin = originOf(url);
    const sources = [live, icons[origin], seedIcons[origin]].filter(Boolean);
    const next = () => {
      const src = sources.shift();
      if (!src) return wrap.replaceChildren(letterIcon(url));
      const img = el("img");
      img.addEventListener("error", next);
      img.src = src;
      wrap.replaceChildren(img);
    };
    next();
    return wrap;
  };

  const leaves = (node) =>
    node.children ? node.children.flatMap(leaves) : [node];

  const hasPinnedChild = (n) => n.children?.some((c) => c.children && c.title === "Pinned");
  const findSpaces = (nodes) => nodes.flatMap((n) => hasPinnedChild(n) ? [n] : n.children ? findSpaces(n.children) : []);

  // The tab that belongs to a pin or favorite stays bound to it wherever it navigates (see 08-pins.js).
  const boundTab = (node) => state.bound.get(node.id);
  const isAway = (tab, node) => !!tab && pinLinks.away(tab, node.url);

  // Re-read the tab right before writing: Vivaldi keeps its own keys in the same field.
  const writeExt = async (tabId, patch) => {
    const local = state.tabs.find((t) => t.id === tabId);
    if (local) local.vivExtData = pinLinks.patched(local, patch);
    try {
      const fresh = await chrome.tabs.get(tabId);
      if (pinLinks.needsWrite(fresh, patch)) await chrome.tabs.update(tabId, { vivExtData: pinLinks.patched(fresh, patch) });
    } catch (_) {}
  };

  // A pin opened from the sidebar remembers where it landed after the site's redirects.
  const recordHome = (tabId, pinId) => {
    const done = () => chrome.tabs.onUpdated.removeListener(onUpdated);
    const onUpdated = async (id, change) => {
      if (id !== tabId || change.status !== "complete") return;
      done();
      try {
        const fresh = await chrome.tabs.get(tabId);
        if (pinLinks.pinOf(fresh) === pinId && pinLinks.homeOf(fresh) === undefined) {
          writeExt(tabId, { [pinLinks.HOME]: pinLinks.norm(fresh.url) });
        }
      } catch (_) {}
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(done, 60000);
  };

  const openPin = async (node) => {
    const tab = await chrome.tabs.create({ url: node.url });
    await writeExt(tab.id, { [pinLinks.PIN]: node.id });
    recordHome(tab.id, node.id);
  };

  // A pin or favorite opens in the space on screen. Its bound tab may sit in another space or another window (a Favorite
  // is shared by every space), so it is looked for in every normal window: the tab bindTabs bound here, plus any tab
  // carrying this bookmark's vivarcPin. One already here in the shown space wins, else the most recently used. A tab
  // elsewhere is moved here and restamped into the shown space BEFORE it is activated, so Vivaldi's record never sees a
  // tab of another space become active.
  const boundAnywhere = async (node) => {
    const own = boundTab(node);
    let found = own ? [own] : [];
    try {
      const every = await chrome.tabs.query({ windowType: "normal" });
      found = [...every.filter((t) => pinLinks.pinOf(t) === node.id), ...found.filter((t) => !every.some((e) => e.id === t.id))];
    } catch (_) {}
    return found;
  };

  const focusOrOpen = async (node) => {
    try {
      const here = state.allTabs[0]?.windowId;
      // Vivaldi's record, read now: state.active is the last debounced refresh's, which can trail a switch
      const shown = (here != null ? window.__vm.native?.record()?.activeIn(here) : null) ?? state.active;
      const tab = spacesOf.pickBound(await boundAnywhere(node), here, shown);
      const action = spacesOf.pinAction(tab, here, shown);
      if (action.kind === "open") return await openPin(node);
      if (action.kind === "bring") {
        await chrome.tabs.move(tab.id, { windowId: here, index: -1 });
        const fresh = await chrome.tabs.get(tab.id);
        await chrome.tabs.update(tab.id, { vivExtData: spacesOf.restamp(fresh, shown) });
      }
      await chrome.tabs.update(tab.id, { active: true });
    } catch (err) {
      console.warn("[vivarc] could not open the pin in this space", err);
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: "Could not open that tab here" }));
    }
  };

  const backToPin = (tab, node) => chrome.tabs.update(tab.id, { url: node.url });

  // The page you are on moves to a regular tab and the pinned tab goes back to its pinned page.
  const separate = async (tab, node) => {
    await chrome.tabs.create({ url: tab.url, index: tab.index + 1 });
    await chrome.tabs.update(tab.id, { url: node.url });
  };

  const bindTabs = () => {
    if (!state.space) { state.bound = new Map(); return; }
    const pins = [...(state.favs ? leaves(state.favs) : []), ...(state.pinned ? leaves(state.pinned) : [])]
      .map((n) => ({ id: n.id, url: n.url }));
    const allIds = state.folders.flatMap((f) => leaves(f)).map((n) => n.id);
    const { bound, writes } = pinLinks.plan(state.tabs, pins, allIds);
    state.bound = bound;
    for (const { tabId, patch } of writes) writeExt(tabId, patch);
  };

  // Favorites are shared by every space (like Arc's); Pinned belongs to the space on screen.
  const ensureFolder = async (name) => {
    const owner = name === "Favorites" ? state.defaultSpace : state.space;
    const existing = owner.children.find((c) => c.children && c.title === name);
    if (existing) return existing;
    return chrome.bookmarks.create({ parentId: owner.id, title: name, index: 0 });
  };

  window.__vm.pinTab = async (tab, kind) => {
    if (!state.space) return false;
    const parent = kind === "Favorites" ? await ensureFolder("Favorites") : (state.pinned || await ensureFolder("Pinned"));
    await chrome.bookmarks.create({ parentId: parent.id, title: tab.title, url: tab.url });
    return true;
  };

  const copy = (text) => navigator.clipboard?.writeText(text).catch(() => {});

  // Removing goes to Vivaldi's bookmark trash, so it can be undone from there.
  const discard = (node) => {
    if (state.trash) chrome.bookmarks.move(node.id, { parentId: state.trash.id });
    else if (node.children) chrome.bookmarks.removeTree(node.id);
    else chrome.bookmarks.remove(node.id);
  };

  const cloneTree = async (node, parentId, suffix = "") => {
    const made = await chrome.bookmarks.create({
      parentId, title: `${node.title}${suffix}`, ...(node.children ? {} : { url: node.url }),
    });
    for (const child of node.children ?? []) await cloneTree(child, made.id);
  };

  const newFolder = async (parent) => {
    const target = parent ?? state.pinned ?? await ensureFolder("Pinned");
    openFolders.add(target.id);
    saveOpen();
    const made = await chrome.bookmarks.create({ parentId: target.id, title: "New Folder" });
    state.renameId = made.id;
  };

  // ---- context menu ----
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  const showMenu = (event, items) => {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    menu = el("div", "vm-menu");
    for (const [label, action, danger] of items) {
      if (!label) { menu.append(el("div", "vm-menu-sep")); continue; }
      const item = el("div", `vm-menu-item${danger ? " danger" : ""}`, label);
      item.addEventListener("click", () => { closeMenu(); action(); });
      menu.append(item);
    }
    (document.querySelector("#browser") || document.body).append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
  };
  const outside = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("focusin", outside, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("blur", closeMenu);
  window.__vm?.onShortcut((key) => { if (key === "esc") closeMenu(); });

  // ---- drag and drop ----
  let drag = null;
  let refreshAfterDrag = false;
  const clearDrop = () => {
    for (const n of panel?.querySelectorAll(".drop-before, .drop-after, .drop-into") ?? []) {
      n.classList.remove("drop-before", "drop-after", "drop-into");
    }
  };

  const wireDrag = (node, payload) => {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      drag = payload;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", payload.url || "");
      closeMenu();
      // Changing the layout inside dragstart makes Chrome cancel the drag, so it waits a frame.
      requestAnimationFrame(() => {
        if (!drag) return;
        node.classList.add("dragging");
        document.querySelector("#browser")?.classList.add("vm-dragging");
      });
    });
    node.addEventListener("dragend", (e) => {
      drag = null;
      if (refreshAfterDrag) refresh(true);
      node.classList.remove("dragging");
      document.querySelector("#browser")?.classList.remove("vm-dragging");
      clearDrop();
      if (payload.type === "tab") tearOffTab(payload.tab, e);
    });
  };

  // A tab row dragged out past the window's edge and taken by nothing opens in a new window, as a plain tab of that
  // window's default space (Byron, 2026-11-08; spec Part 2, Tabs). It leaves its space on purpose: a space lives in one
  // window, so a tab that kept a space still shown here would be gathered straight back by repair 3.
  // Order: the window is made first (the tab moves into it), and only then is the tab restamped, because while it is
  // still the active tab here, changing its space is a switch in this window (G4). Repairs wait on the gesture mark the
  // whole time, so none gathers the tab home between the move and the restamp.
  const tearOffTab = async (dragged, e) => {
    let endBusy = null;
    try {
      const bounds = { left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight };
      const point = { x: e.screenX, y: e.screenY };
      const there = { point, bounds, kind: "tab", dropEffect: e.dataTransfer?.dropEffect };
      if (!spacesOf.tearOff({ ...there, tabCount: 2 })) return; // the cheap checks first: nothing is read or marked for a drop that stays
      endBusy = window.__vm.spaceRepair?.gesture() ?? null;
      const inWindow = await chrome.tabs.query({ currentWindow: true });
      // The display is only known for points on this window's own display; elsewhere the browser keeps the window visible.
      const s = window.screen;
      const onDisplay = point.x >= s.availLeft && point.x < s.availLeft + s.availWidth && point.y >= s.availTop && point.y < s.availTop + s.availHeight;
      const place = spacesOf.tearOff({ ...there, tabCount: inWindow.length,
        screen: onDisplay ? { left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight } : null });
      if (!place) return;
      const tab = await chrome.tabs.get(dragged.id); // the row's copy may be stale
      let fresh = null;
      try {
        fresh = await chrome.windows.create({ tabId: tab.id, left: place.left, top: place.top, focused: true });
      } catch (error) {
        console.warn("[vivarc] tab to a new window:", error);
        window.dispatchEvent(new CustomEvent("vm-toast", { detail: "Could not open the tab in a new window." }));
        return;
      }
      try {
        let now = await chrome.tabs.get(tab.id);
        for (let i = 0; i < 20 && now.windowId !== fresh.id; i++) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          now = await chrome.tabs.get(tab.id);
        }
        if (now.windowId !== fresh.id) throw new Error("the tab did not arrive in the new window");
        if (spacesOf.of(now) !== 0) await chrome.tabs.update(tab.id, { vivExtData: spacesOf.restamp(now, 0) });
      } catch (error) {
        // The tab is in the new window, still in its old space: repair 3 gathers it home. Nothing to undo here.
        console.warn("[vivarc] tab to a new window, left in its old space (repairs gather it home):", error);
      }
    } catch (error) {
      console.warn("[vivarc] tab to a new window:", error);
    } finally { endBusy?.(); }
  };

  // zone: "before" | "after" | "into" depending on pointer position inside the target
  const wireDrop = (node, { horizontal = false, allowInto = false, accept, onDrop }) => {
    const zoneOf = (e) => {
      const r = node.getBoundingClientRect();
      const t = horizontal ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
      if (allowInto) return t < 0.28 ? "before" : t > 0.72 ? "after" : "into";
      return t < 0.5 ? "before" : "after";
    };
    node.addEventListener("dragover", (e) => {
      if (!drag || (accept && !accept(drag))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      clearDrop();
      node.classList.add(`drop-${zoneOf(e)}`);
    });
    node.addEventListener("drop", async (e) => {
      if (!drag || (accept && !accept(drag))) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = zoneOf(e), payload = drag;
      drag = null;
      clearDrop();
      try { await onDrop(zone, payload); } catch (err) { console.warn("[vivarc] drop:", err); }
    });
  };

  const isBookmark = (d) => d.type === "bm";
  const insertPinned = async (data, parentId, index) => {
    if (data.type === "bm") {
      await chrome.bookmarks.move(data.node.id, { parentId, ...(index == null ? {} : { index }) });
    } else {
      const existing = [...(state.pinned ? leaves(state.pinned) : []), ...(state.favs ? leaves(state.favs) : [])]
        .find((n) => sameSite(data.tab.url, n.url) && n.url === data.tab.url);
      if (existing) await chrome.bookmarks.move(existing.id, { parentId, ...(index == null ? {} : { index }) });
      else await chrome.bookmarks.create({ parentId, title: data.tab.title, url: data.tab.url, ...(index == null ? {} : { index }) });
    }
  };
  const unpin = async (data) => {
    if (data.type !== "bm" || data.node.children) return;
    const { url } = data.node;
    const hadTab = boundTab(data.node);
    discard(data.node);
    if (!hadTab) await chrome.tabs.create({ url, active: false });
  };

  // ---- rows ----
  const actionButton = (symbol, title, onClick) => {
    const b = el("span", "vm-act", symbol);
    b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  };

  // `save` stores a changed name: a bookmark's by default, a tab folder's for its tabs.
  let renameField = null; // the name being typed: the sidebar holds its re-renders until it is done
  // Only while the field is on screen and has the cursor: one that never got it (the sidebar was hidden) holds nothing up.
  const naming = () => !!renameField?.isConnected && document.activeElement === renameField;
  const editTitle = (field, node, cleanup = () => {}, save = (title) => chrome.bookmarks.update(node.id, { title })) => {
    renameField = field;
    field.value = node.title;
    field.focus();
    field.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (renameField === field) renameField = null;
      cleanup();
      const title = field.value.trim();
      if (commit && title && title !== node.title) {
        Promise.resolve().then(() => save(title)).catch((error) => console.warn("[vivarc] rename:", error)).finally(() => refresh(false));
      } else refresh(true);
    };
    field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    field.addEventListener("blur", () => finish(true));
    field.addEventListener("click", (e) => e.stopPropagation());
  };
  const startRename = (titleEl, node, save) => {
    const field = el("input", "vm-rename");
    titleEl.replaceWith(field);
    editTitle(field, node, undefined, save);
  };
  // A favorite tile only shows its icon, so its name is edited in a field floating under its row of the grid.
  const renameFavorite = (tile, node) => {
    const grid = tile.closest(".vm-favs");
    if (!grid) return;
    const box = grid.getBoundingClientRect();
    const field = el("input", "vm-rename-float");
    field.style.left = `${box.left}px`;
    field.style.top = `${tile.getBoundingClientRect().bottom + 6}px`;
    field.style.width = `${box.width}px`;
    (document.querySelector("#browser") || document.body).append(field);
    editTitle(field, node, () => field.remove());
  };

  const bookmarkMenu = (node, isFav) => (e) => {
    const tab = boundTab(node);
    showMenu(e, [
      ["Open in New Tab", () => chrome.tabs.create({ url: node.url })],
      ["Copy Link", () => copy(node.url)],
      ["Rename…", () => { state.renameId = node.id; refresh(true); }],
      ...(isAway(tab, node) ? [
        [isFav ? "Back to Favorite Page" : "Back to Pinned Page", () => backToPin(tab, node)],
        ["Separate From Pinned Tab", () => separate(tab, node)],
      ] : []),
      [isFav ? "Move to Pinned" : "Move to Favorites", async () => {
        const target = isFav ? state.pinned : await ensureFolder("Favorites");
        if (target) chrome.bookmarks.move(node.id, { parentId: target.id });
      }],
      ...(tab ? [["Close Tab", () => chrome.tabs.remove(tab.id)]] : []),
      [],
      [isFav ? "Remove from Favorites" : "Remove from Pinned", () => discard(node), true],
    ]);
  };

  const pinnedLink = (node, depth) => {
    const row = el("div", "vm-row vm-link");
    row.style.paddingLeft = `${8 + depth * 20}px`;
    const tab = boundTab(node);
    const away = isAway(tab, node);
    row.title = away ? `${node.title || node.url}\n${tab.url}` : node.url;
    if (tab?.active) row.classList.add("active");
    if (away) row.classList.add("away");
    row.append(iconEl(node.url, away ? undefined : tab?.favIconUrl));
    if (away) row.append(el("span", "vm-away-mark", "/"));
    const title = el("span", "vm-title", away ? (tab.title || tab.url) : (node.title || node.url));
    row.append(title);
    if (away) row.append(actionButton("↩", "Back to pinned page", () => backToPin(tab, node)));
    if (!tab) row.append(actionButton("×", "Remove from Pinned", () => discard(node)));
    else if (away) row.append(actionButton("–", "Separate From Pinned Tab", () => separate(tab, node)));
    else row.append(actionButton("–", "Close tab", () => chrome.tabs.remove(tab.id)));
    row.addEventListener("click", () => focusOrOpen(node));
    row.addEventListener("contextmenu", bookmarkMenu(node, false));
    wireDrag(row, { type: "bm", node, url: node.url });
    wireDrop(row, {
      onDrop: async (zone, data) => {
        if (data.type === "bm" && data.node.id === node.id) return;
        await insertPinned(data, node.parentId, node.index + (zone === "after" ? 1 : 0));
      },
    });
    if (state.renameId === node.id) {
      state.renameId = null;
      setTimeout(() => startRename(title, node), 0);
    }
    return row;
  };

  const folderMenu = (node) => (e) => showMenu(e, [
    ["New Nested Folder…", () => newFolder(node)],
    ["Rename…", () => { state.renameId = node.id; refresh(true); }],
    [],
    ["Copy All Links", () => copy(leaves(node).map((l) => l.url).join("\n"))],
    ["Open All in New Tabs", () => leaves(node).forEach((l) => chrome.tabs.create({ url: l.url, active: false }))],
    ["Duplicate", () => cloneTree(node, node.parentId, " copy")],
    [],
    ["Delete", () => discard(node), true],
  ]);

  const pinnedNode = (node, depth) => {
    if (!node.children) return pinnedLink(node, depth);
    const wrap = el("div", "vm-folder");
    const head = el("div", "vm-row vm-folder-head");
    head.style.paddingLeft = `${8 + depth * 20}px`;
    const glyph = el("span", "vm-glyph");
    const title = el("span", "vm-title", node.title || "Untitled");
    head.append(glyph, title);
    const body = el("div", "vm-folder-body");
    const content = el("div", "vm-folder-content");
    node.children.forEach((c) => content.append(pinnedNode(c, depth + 1)));
    body.append(content);
    const sync = () => {
      const open = openFolders.has(node.id);
      wrap.classList.toggle("open", open);
      content.inert = !open; // a shut folder's rows stay in the page for the animation; keep them out of reach
      glyph.innerHTML = open ? ICON_OPEN : ICON_CLOSED;
    };
    head.addEventListener("click", () => {
      openFolders.has(node.id) ? openFolders.delete(node.id) : openFolders.add(node.id);
      saveOpen();
      sync();
    });
    head.addEventListener("contextmenu", folderMenu(node));
    wireDrag(head, { type: "bm", node, url: "" });
    wireDrop(head, {
      allowInto: true,
      accept: (d) => !(d.type === "bm" && d.node.id === node.id),
      onDrop: async (zone, data) => {
        if (zone === "into") {
          openFolders.add(node.id);
          saveOpen();
          await insertPinned(data, node.id, null);
        } else {
          await insertPinned(data, node.parentId, node.index + (zone === "after" ? 1 : 0));
        }
      },
    });
    sync();
    wrap.append(head, body);
    if (state.renameId === node.id) {
      state.renameId = null;
      setTimeout(() => startRename(title, node), 0);
    }
    return wrap;
  };

  const favTile = (node) => {
    const tile = el("div", "vm-fav");
    tile.title = node.title || node.url;
    const tab = boundTab(node);
    const away = isAway(tab, node);
    if (tab?.active) tile.classList.add("active");
    if (away) tile.classList.add("away");
    tile.append(iconEl(node.url, away ? undefined : tab?.favIconUrl));
    tile.addEventListener("click", () => focusOrOpen(node));
    tile.addEventListener("contextmenu", bookmarkMenu(node, true));
    wireDrag(tile, { type: "bm", node, url: node.url });
    wireDrop(tile, {
      horizontal: true,
      accept: (d) => !(d.type === "bm" && d.node.children),
      onDrop: async (zone, data) => {
        if (data.type === "bm" && data.node.id === node.id) return;
        await insertPinned(data, node.parentId, node.index + (zone === "after" ? 1 : 0));
      },
    });
    if (state.renameId === node.id) {
      state.renameId = null;
      setTimeout(() => renameFavorite(tile, node), 0);
    }
    return tile;
  };

  // ---- tab folders: Vivaldi's tab stacks (09-stacks.js) ----
  const stacksOf = window.__vm.stacks;
  const { indexBeside } = stacksOf;
  const closedStacks = new Set(); // folders shut by the user (saved); a folder starts open
  let shownStacks = []; // the folders on screen, set by render(): what a drop treats as a folder
  // Read, change, write: every window shares the saved list, so a window's own copy would undo another's change.
  const setStackClosed = async (id, closed) => {
    closed ? closedStacks.add(id) : closedStacks.delete(id);
    const saved = new Set(await store.get("stacks:closed", []));
    closed ? saved.add(id) : saved.delete(id);
    await store.set("stacks:closed", [...saved]);
  };
  // A folder action from a menu: a failure says so, instead of failing silently.
  const folderAction = (run, failed) => () => Promise.resolve().then(run).catch((error) => {
    console.warn("[vivarc] folders:", error);
    window.dispatchEvent(new CustomEvent("vm-toast", { detail: failed }));
  }).finally(() => refresh(false));
  // A stack's name is Vivaldi's to keep (it ignores writes to the tabs' fixedGroupTitle): its own rename call.
  const nameStack = (id, title) => vivaldi.tabsPrivate.setGroupProperties({ groupExtId: id, groupTitle: title });
  // Vivaldi's own tab-stack moves (PageActions.createTabStack, moveToIndex with "ungroup"). Vivaldi 8.3 changed them:
  // "target-is-tab" is gone (its argument check rejects it), a number is always a tab id that the tabs land before (or
  // "first" / "last"), and an index no longer resolves. Which Vivaldi this is gets found once, with no side effects: an
  // empty move with the old tweak, which 8.3 rejects in its argument check and 8.2 answers with "nothing to move".
  const stackMove = (args) => vivaldi.tabsPrivate.move({ ...args, debug: "Vivarc.folders" });
  let modernMove = null;
  const isModern = async () => {
    if (modernMove !== null) return modernMove;
    try {
      await stackMove({ tabIds: [], target: 0, tweaks: ["target-is-tab"] });
      modernMove = false;
    } catch (error) {
      if (!/Value must be one of/.test(String(error))) throw error;
      modernMove = true;
    }
    return modernMove;
  };
  // The target for tabs to start at `index` (where chrome.tabs.move would put them): the index on 8.2; on 8.3 the tab
  // they land before, among the window's other tabs.
  const placeAt = async (ids, windowId, index) => {
    if (!(await isModern())) return index;
    const others = (await chrome.tabs.query({ windowId })).filter((t) => !ids.includes(t.id)).sort((a, b) => a.index - b.index);
    return stacksOf.anchor(others.map((t) => t.id), index);
  };
  const createFolder = async (dragged, withId) => {
    const tweaks = (await isModern()) ? ["do-not-reparent", "create-new-group"]
      : ["do-not-reparent", "create-new-group", "target-is-tab"];
    const result = await stackMove({ tabIds: [withId, dragged.id], target: withId, tweaks });
    if (!result?.group) throw new Error("Vivaldi did not make the stack");
    state.renameId = `stack:${result.group}`; // name it as it is made, like Arc
  };
  const joinFolder = async (dragged, members) => {
    const anchor = members[members.length - 1];
    const tweaks = (await isModern()) ? ["into", "do-not-reparent"] : ["target-is-tab", "into", "do-not-reparent"];
    await stackMove({ tabIds: [dragged.id], target: stacksOf.ext(anchor).ext_id || anchor.id, windowId: anchor.windowId, tweaks });
  };
  const stillStacked = async (ids) =>
    (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).some((t) => t && stacksOf.stackOf(t));
  // Out of their folder, to `index`. Vivaldi only ungroups tabs it really moves: at their own place it answers "nothing to
  // move". They then step over one neighbour with "ungroup" (a spare tab when they are the whole window), and that
  // neighbour goes back with a plain one-tab move, which leaves them loose where they were. (Tabs of a stack sit side by
  // side; with another space's tab between them, Vivaldi's move gathers them, as its own Remove from Stack does.)
  const leaveFolder = async (tabs, index) => {
    const ids = tabs.map((t) => t.id);
    const windowId = tabs[0].windowId;
    const moved = await stackMove({ tabIds: ids, target: await placeAt(ids, windowId, index), windowId, tweaks: ["ungroup"] });
    if (moved?.success === false && moved.message !== "nothing to move") throw new Error(moved.message || "Vivaldi did not move the tabs");
    if (!(await stillStacked(ids))) return; // out, wherever Vivaldi was asked to put them
    const start = Math.min(...(await Promise.all(ids.map((id) => chrome.tabs.get(id)))).map((t) => t.index));
    const total = (await chrome.tabs.query({ windowId })).length;
    let step = stacksOf.nudge(start, ids.length, total);
    const spare = step === null ? await chrome.tabs.create({ windowId, active: false, index: total }) : null;
    if (spare) step = stacksOf.nudge(start, ids.length, total + 1);
    try {
      const before = await chrome.tabs.query({ windowId });
      const neighbour = before.find((t) => t.index === step.neighbour);
      const target = (await isModern()) ? await placeAt(ids, windowId, step.to) : step.target;
      await stackMove({ tabIds: ids, target, windowId, tweaks: ["ungroup"] });
      if (neighbour && !spare) await chrome.tabs.move(neighbour.id, { index: step.neighbour });
    } finally {
      if (spare) await chrome.tabs.remove(spare.id).catch(() => {});
    }
  };
  // A tab dropped on a tab row ({ tab }) or a folder's head ({ stack, tabs }); see stacks.dropAction.
  const dropTab = async (dragged, target, zone) => {
    const action = stacksOf.dropAction(dragged, target, zone, shownStacks);
    const members = target.tabs || state.tabs.filter((t) => stacksOf.stackOf(t) === action.stack);
    const beside = target.tab || (zone === "before" ? target.tabs[target.tabs.length - 1] : target.tabs[0]);
    if (action.op === "create") await createFolder(dragged, action.with);
    else if (action.op === "join") await joinFolder(dragged, members);
    else if (action.op === "leave") await leaveFolder([dragged], indexBeside(dragged, beside, zone));
    else if (action.op === "move") await chrome.tabs.move(dragged.id, { index: indexBeside(dragged, beside, zone) });
    refresh(false);
  };

  // The spaces as the space bar lists them (default first, under its sidebar name).
  const spaceItems = () => spacesOf.items(state.workspaces, state.defaultSpace ? spacesOf.label(state.defaultSpace) : "Home");
  // "Move to <Space>": the spaces a tab can go to; none while the space list is unknown.
  const moveTargets = () => (state.workspaces?.length ? spacesOf.moveTargets(spaceItems(), state.active) : []);
  // Vivaldi's own move (08-space-native.js); this window stays on the space it shows. A tab bound for a space shown in
  // another window goes there with the move; the repair run is asked as well, as a safety net, though a non-leader
  // window's request does nothing (the leader runs repairs).
  let warnedMove = false;
  const moveTabToSpace = async (tab, target) => {
    try {
      await window.__vm.native.moveToSpace([tab.id], target.id);
      window.__vm.spaceRepair?.schedule();
      refresh(false);
    } catch (error) {
      if (!warnedMove) { warnedMove = true; console.warn("[vivarc] move to space:", error); }
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: error?.code === "parked-elsewhere"
        ? "That space is in another window. Show it there first, then move the tab."
        : "Could not move the tab. Use Vivaldi's Move to Workspace command." }));
    }
  };

  const tabRow = (tab, depth = 0) => {
    const row = el("div", "vm-row vm-tab");
    row.style.paddingLeft = `${8 + depth * 20}px`;
    if (tab.active) row.classList.add("active");
    if (tab.discarded) row.classList.add("discarded");
    row.title = tab.url;
    row.append(iconEl(tab.url, tab.favIconUrl), el("span", "vm-title", tab.title || tab.url));
    if (window.__vm.tilingOf(tab)) row.append(el("span", "vm-split-mark", "◫"));
    row.append(actionButton("×", "Close tab", () => chrome.tabs.remove(tab.id)));
    row.addEventListener("click", () => chrome.tabs.update(tab.id, { active: true }));
    row.addEventListener("auxclick", (e) => { if (e.button === 1) chrome.tabs.remove(tab.id); });
    wireDrag(row, { type: "tab", tab, url: tab.url });
    // The middle of the row makes a folder with this tab (or joins its folder); its edges move the tab beside it.
    wireDrop(row, {
      allowInto: true,
      onDrop: async (zone, data) => {
        if (data.type === "bm") return unpin(data);
        await dropTab(data.tab, { tab }, zone);
      },
    });
    // Out of the folder, just above it.
    const removeFromFolder = folderAction(() => {
      const folder = state.tabs.filter((t) => stacksOf.stackOf(t) === stacksOf.stackOf(tab));
      return leaveFolder([tab], Math.max(...folder.map((t) => t.index)));
    }, "Could not take the tab out of its folder");
    row.addEventListener("contextmenu", (e) => showMenu(e, [
      ...(depth ? [["Remove from Folder", removeFromFolder], []] : []),
      ...(state.space ? [
        ["Pin Tab", async () => chrome.bookmarks.create({
          parentId: (state.pinned || await ensureFolder("Pinned")).id, title: tab.title, url: tab.url })],
        ["Add to Favorites", async () => chrome.bookmarks.create({
          parentId: (await ensureFolder("Favorites")).id, title: tab.title, url: tab.url })],
        [],
      ] : []),
      ...moveTargets().flatMap((target, i, all) => [[`Move to ${target.name}`, () => moveTabToSpace(tab, target)], ...(i === all.length - 1 ? [[]] : [])]),
      ["Duplicate Tab", () => chrome.tabs.duplicate(tab.id)],
      ["Copy Link", () => copy(tab.url)],
      [],
      ["Close Tab", () => chrome.tabs.remove(tab.id)],
      ["Close Other Tabs", () => {
        const ids = state.tabs.filter((t) => t.id !== tab.id && !t.pinned).map((t) => t.id);
        if (ids.length) chrome.tabs.remove(ids);
      }],
    ]));
    return row;
  };

  // A tab folder, in the pinned folders' look: its tabs inside, the newest first as in the list.
  const stackNode = ({ id, tabs }) => {
    const wrap = el("div", "vm-folder vm-stack");
    const head = el("div", "vm-row vm-folder-head");
    head.style.paddingLeft = "8px";
    const glyph = el("span", "vm-glyph");
    const name = stacksOf.titleOf(tabs);
    const title = el("span", "vm-title", name);
    head.append(glyph, title);
    const body = el("div", "vm-folder-body");
    const content = el("div", "vm-folder-content");
    [...tabs].reverse().forEach((t) => content.append(tabRow(t, 1)));
    body.append(content);
    const sync = () => {
      const open = !closedStacks.has(id);
      wrap.classList.toggle("open", open);
      content.inert = !open; // a shut folder's rows stay in the page for the animation; keep them out of reach
      glyph.innerHTML = open ? ICON_OPEN : ICON_CLOSED;
      // a shut folder holding the active tab shows it on its head
      head.classList.toggle("active", !open && tabs.some((t) => t.active));
    };
    head.addEventListener("click", () => {
      setStackClosed(id, !closedStacks.has(id));
      sync();
    });
    head.addEventListener("contextmenu", (e) => showMenu(e, [
      ["Rename…", () => { state.renameId = `stack:${id}`; refresh(false); }],
      ["Ungroup", folderAction(() => leaveFolder(tabs, tabs[0].index), "Could not ungroup the folder")],
      [],
      // As Clear does: closing every tab of the space would leave it empty, so a new tab stays.
      ["Close All Tabs", folderAction(async () => {
        if (tabs.length === state.tabs.length) await chrome.tabs.create({});
        await chrome.tabs.remove(tabs.map((t) => t.id));
      }, "Could not close the folder's tabs"), true],
    ]));
    // Into the head joins the folder. Above it is outside; below an open head is inside the folder, below a shut one
    // is outside.
    wireDrop(head, {
      allowInto: true,
      accept: (d) => d.type === "tab",
      onDrop: (zone, data) => dropTab(data.tab, { stack: id, tabs },
        zone === "after" && !closedStacks.has(id) ? "into" : zone),
    });
    sync();
    wrap.append(head, body);
    if (state.renameId === `stack:${id}`) {
      state.renameId = null;
      setTimeout(() => startRename(title, { title: name }, (next) => nameStack(id, next)), 0);
    }
    return wrap;
  };

  // ---- profile switcher ----
  const openProfile = (path) => vivaldi.runtimePrivate.openNamedProfile(path, (ok) => {
    if (!ok) console.warn("[vivarc] could not open profile", path);
  });

  const profileChip = (chip, index) => {
    const node = el("div", `vm-space-chip${chip.active ? " active" : ""}`);
    node.title = chip.active ? chip.name : `${chip.name}${index < 9 ? ` (${window.__vm.windows ? "Ctrl+Shift+" : "⌃⌘"}${index + 1})` : ""}`;
    const letter = () => {
      const span = el("span", "vm-space-letter", chip.letter);
      span.style.backgroundColor = `hsl(${chip.hue} 38% 40%)`;
      return span;
    };
    if (chip.avatar) {
      const img = el("img");
      img.addEventListener("error", () => img.replaceWith(letter()));
      img.src = chip.avatar;
      node.append(img);
    } else {
      node.append(letter());
    }
    if (chip.active) {
      node.addEventListener("contextmenu", (e) => showMenu(e, [
        ["Manage Profiles…", () => vivaldi.runtimePrivate.openProfileSelectionWindow()],
      ]));
    } else {
      node.addEventListener("click", () => openProfile(chip.path));
    }
    return node;
  };

  const promptProfileName = (bar, plus) => {
    const field = el("input", "vm-space-input");
    field.placeholder = "New profile";
    try { vivaldi.runtimePrivate.getProfileDefaults((name) => { if (!field.value) field.value = name || ""; field.select(); }); } catch (_) {}
    plus.replaceWith(field);
    field.focus();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const name = field.value.trim();
      if (commit && name) {
        const images = await new Promise((resolve) => vivaldi.runtimePrivate.getUserProfileImages(resolve));
        const index = Math.floor(Math.random() * (images?.length || 1));
        vivaldi.runtimePrivate.createProfile(name, index, false, (ok) => { if (!ok) console.warn("[vivarc] could not create the profile"); });
      }
      renderProfileBar();
    };
    field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    field.addEventListener("blur", () => finish(false));
  };

  let profileBarEl = null;
  const renderProfileBar = () => {
    const chips = window.__vm.spaces.profileChips(state.profiles);
    if (!chips.length) { profileBarEl?.remove(); return; }
    profileBarEl ||= el("div", "vm-spaces");
    const plus = el("div", "vm-space-chip vm-space-plus", "+");
    plus.title = "New profile";
    plus.addEventListener("click", () => promptProfileName(profileBarEl, plus));
    profileBarEl.replaceChildren(...chips.map(profileChip), plus);
  };

  const placeProfileBar = () => {
    if (!profileBarEl?.isConnected && profileBarEl) {
      const toolbar = document.querySelector("#tabs-tabbar-container .toolbar-tabbar-after");
      toolbar?.prepend(profileBarEl);
    }
  };

  const loadProfiles = () => {
    try {
      vivaldi.runtimePrivate.getUserProfiles((list) => {
        state.profiles = list || [];
        renderProfileBar();
        placeProfileBar();
        window.__vm.spaces.syncBottomBar(window.__vm.spaces.wantsAccountButton(state.profiles)).catch((e) => console.warn("[vivarc] bottom bar:", e));
      });
    } catch (e) {
      console.warn("[vivarc] profile list unavailable:", e);
    }
  };

  // ---- space bar: Vivaldi workspaces as Arc-style spaces ----
  // Vivaldi's own switch (08-space-native.js). Throws up front when it cannot be found, before any side effect.
  const nativeSwitcher = () => {
    if (!window.__vm.native?.hasSwitch()) throw new Error("Native workspace switching is unavailable");
    return window.__vm.native.switchTo;
  };
  const switchFailed = (error) => {
    console.warn("[vivarc] switch space:", error);
    window.dispatchEvent(new CustomEvent("vm-toast", { detail: "Could not switch space. Use Vivaldi's workspace shortcut." }));
  };
  // The window showing a space: Vivaldi's record; the active tab's space stands in only when the record can't be found.
  const shownWindowOf = async (id) => {
    const record = window.__vm.native?.record()?.all() ?? null;
    const activeTabs = record ? [] : await chrome.tabs.query({ active: true, windowType: "normal" });
    return spacesOf.shownIn(activeTabs, record, id);
  };
  // One entry for every gesture on a tile. The snapshot (tabs, Vivaldi's record, this window) is read fresh, because
  // the rendered state can be stale while a re-render waits on a rename or a drag; spacesOf.tileAction decides, and
  // this carries it out. A plain click never moves tabs between windows, with one exception: on a space split across
  // windows it gathers every tab into the window the space lives in, as repair 3 would. Only a pull and a move to a
  // new window move tabs on purpose.
  // The guard covers a pull or a move under way, since a switch during one would race it. It is claimed before the
  // first await (a fast double click must not pass the check twice) and released as soon as the gesture turns out to
  // be a plain one. It expires after 10 s so a stuck move can't lock the tiles for good; a click it ignores says so.
  const PULL_GUARD_MS = 10000;
  let pullingUntil = 0;
  const actOnTile = async (item, event) => {
    if (Date.now() < pullingUntil) {
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: "Still moving a space…" }));
      return;
    }
    const claim = Date.now() + PULL_GUARD_MS;
    pullingUntil = claim;
    // only release a claim that is still ours: an earlier move outliving its expiry must not clear a later one
    const release = () => { if (pullingUntil === claim) pullingUntil = 0; };
    // Repairs run in the leader window, which may be another one: a move under way tells them to wait (11-space-repair.js).
    let endBusy = null;
    try {
      const wantsNew = spacesOf.wantsNewWindow(event);
      const win = await chrome.windows.getCurrent();
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      const record = window.__vm.native?.record()?.all() ?? new Map();
      const action = spacesOf.tileAction({ id: item.id, here: win.id, tabs, record, shift: !!event?.shiftKey, newWindow: wantsNew });
      if (action.kind !== "pull" && action.kind !== "new-window") release();
      else endBusy = window.__vm.spaceRepair?.gesture() ?? null;
      if (action.kind === "none") return;
      if (action.kind === "focus") { await window.__vm.native.focus(action.window); refresh(false); return; } // needs no switch
      const activate = nativeSwitcher(); // throws here, before any side effect, when Vivaldi's switch is missing
      if (action.kind === "show") {
        await activate(win.id, item.id);
      } else if (action.kind === "show-there") {
        // A10: the switch doesn't focus, so the window comes to the front after it shows the space.
        await activate(action.window, item.id);
        await window.__vm.native.focus(action.window);
      } else if (action.kind === "new-window") {
        await spaceToNewWindow(item);
      } else if (action.kind === "pull") {
        // Frees the space first: the window showing it goes to its own default, then Vivaldi's switch moves every
        // tab of the space here. A parked space is shown nowhere, so there is nothing to free.
        const shown = spacesOf.shownIn(record.size ? [] : tabs.filter((t) => t.active), record.size ? record : null, item.id);
        if (shown != null && shown !== win.id) await activate(shown, 0);
        await activate(win.id, item.id);
        await chrome.windows.update(win.id, { focused: true });
      }
      refresh(false);
    } catch (error) { switchFailed(error); } finally { release(); endBusy?.(); }
  };
  // Ctrl+shift+click (cmd+shift+click on a Mac) sends a space to a new window of its own: the reverse of the pull.
  // Where it is active (this window included) that window goes to its default space first, which frees the space;
  // then Vivaldi's switch, called for the new window, moves the space's tabs there. The new window starts on
  // about:blank, not a start page, so the command bar does not open on it, and that tab closes once the space is in.
  // A brand-new window may not be known to Vivaldi's switch at once. A retry must first put the new window back on its
  // default space: Vivaldi marks the space active there before moving any tab, and a second call for a space marked
  // active only focuses the window. If the space never arrives, the new window (which then holds none of its tabs)
  // closes, which also clears that mark, and the space goes back to the window it came from.
  const spaceInWindow = async (windowId, id) =>
    (await chrome.tabs.query({ windowId })).some((t) => spacesOf.of(t) === id);
  const arrives = async (windowId, id, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 150))) {
      if (await spaceInWindow(windowId, id)) return true;
    }
    return spaceInWindow(windowId, id);
  };
  const spaceToNewWindow = async (item) => {
    if (!item.id) return;
    let activate = null, holder = null, fresh = null;
    try {
      activate = nativeSwitcher();
      holder = await shownWindowOf(item.id);
      if (holder != null) await activate(holder, 0);
      fresh = await chrome.windows.create({ url: "about:blank", focused: true });
      const helper = fresh.tabs?.[0]?.id;
      let moved = false;
      for (let attempt = 0; attempt < 3 && !moved; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt ? 500 : 250));
        if (attempt) await activate(fresh.id, 0);
        await activate(fresh.id, item.id);
        moved = await arrives(fresh.id, item.id, 1500);
      }
      if (!moved) throw new Error("the space did not move to the new window");
      if (helper != null) await chrome.tabs.remove(helper).catch(() => {});
      await chrome.windows.update(fresh.id, { focused: true });
      refresh(false);
    } catch (error) {
      console.warn("[vivarc] space to a new window:", error);
      // undo: only a new window that holds none of the space's tabs is closed, and the space goes back where it was
      if (fresh && !(await spaceInWindow(fresh.id, item.id).catch(() => true))) {
        await chrome.windows.remove(fresh.id).catch(() => {});
        if (holder != null && activate) await activate(holder, item.id).catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: "Could not move the space to a new window." }));
    }
  };

  let spaceTooltip = null;
  const hideSpaceTooltip = () => { spaceTooltip?.remove(); spaceTooltip = null; };
  const spacePill = (item) => {
    const openElsewhere = !!item.id && (state.dots || []).includes(item.id);
    const hint = spacesOf.tileHint(item, openElsewhere);
    const pill = el("button", `vm-space-pill${item.id === state.active ? " active" : ""}${openElsewhere ? " elsewhere" : ""}`);
    pill.type = "button";
    pill.setAttribute("aria-label", hint);
    pill.setAttribute("aria-pressed", String(item.id === state.active));
    if (item.emoji) pill.textContent = item.emoji;
    else if (typeof item.icon === "string" && item.icon.trim().startsWith("<svg")) {
      // Render the native SVG as a mask: no HTML injection, and it follows the theme.
      const icon = el("span", "vm-workspace-icon");
      icon.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(item.icon)}")`;
      pill.append(icon);
    } else pill.textContent = Array.from((item.name || "").trim())[0]?.toLocaleUpperCase() || "?";
    const showName = () => {
      hideSpaceTooltip();
      spaceTooltip = el("div", "vm-space-tooltip", hint);
      spaceTooltip.setAttribute("role", "tooltip");
      document.body.append(spaceTooltip);
      const rect = pill.getBoundingClientRect();
      const width = spaceTooltip.getBoundingClientRect().width;
      spaceTooltip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
      spaceTooltip.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    };
    pill.addEventListener("mouseenter", showName);
    pill.addEventListener("focus", showName);
    pill.addEventListener("mouseleave", hideSpaceTooltip);
    pill.addEventListener("blur", hideSpaceTooltip);
    pill.addEventListener("click", (event) => {
      hideSpaceTooltip();
      actOnTile(item, event);
    });
    if (item.id) pill.addEventListener("contextmenu", (e) => { hideSpaceTooltip(); confirmDeleteSpace(item, e); });
    return pill;
  };

  const confirmDeleteSpace = async (item, event) => {
    // The default action and propagation must be stopped now; the menu itself opens once the count is in.
    event.preventDefault();
    event.stopPropagation();
    const at = { clientX: event.clientX, clientY: event.clientY, preventDefault() {}, stopPropagation() {} };
    let tabs = state.allTabs;
    try { tabs = await chrome.tabs.query({ windowType: "normal" }); } catch (_) {}
    try {
      const { tabCount, windowCount, closesWindow } = spacesOf.removalScope(tabs, item.id);
      const label = spacesOf.removalLabel(item.name, tabCount, windowCount, closesWindow);
      showMenu(at, [[label, () => deleteSpace(item), true], ["Cancel", () => {}]]);
    } catch (_) {}
  };

  const deleteSpace = async (item) => {
    const remove = spacesOf.findRemover(window.webpackChunkgapp_browser_react) ||
      spacesOf.findRemover(chrome.extension.getBackgroundPage?.()?.webpackChunkgapp_browser_react);
    if (!remove) {
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: "Could not delete the space. Use Vivaldi's Workspaces button." }));
      return;
    }
    const win = await chrome.windows.getCurrent();
    await remove(win.id, item.id);
    refresh(false);
  };

  const openCreateSpaceDialog = async () => {
    try {
      const create = spacesOf.findCreator(window.webpackChunkgapp_browser_react) ||
        spacesOf.findCreator(chrome.extension.getBackgroundPage?.()?.webpackChunkgapp_browser_react);
      if (!create) throw new Error("Workspace dialog unavailable");
      const win = await chrome.windows.getCurrent();
      await create(win.id);
    } catch (error) {
      console.warn("[vivarc] create space:", error);
      window.dispatchEvent(new CustomEvent("vm-toast", { detail: spacesOf.CREATE_HINT }));
    }
  };

  const spaceBar = () => {
    const items = spaceItems();
    const bar = el("div", "vm-space-bar");
    const plus = el("div", "vm-space-pill vm-space-plus", "+");
    plus.title = "Create a new space";
    plus.addEventListener("click", openCreateSpaceDialog);
    bar.append(...items.map(spacePill), plus);
    return bar;
  };

  // ---- render ----
  const currentUrlField = () => {
    const active = state.allTabs.find((tab) => tab.active);
    const url = active?.pendingUrl || active?.url || "";
    const field = el("input", "vm-current-url");
    field.type = "text";
    field.readOnly = true;
    field.value = url;
    field.title = url;
    field.placeholder = "No active page";
    field.setAttribute("aria-label", "Current page URL");
    field.spellcheck = false;
    // A click edits the address in the command bar, filled in and selected; the field itself only shows it.
    field.addEventListener("mousedown", (event) => { if (event.button === 0) event.preventDefault(); });
    field.addEventListener("click", () => window.dispatchEvent(new CustomEvent("vm-edit-url")));
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") window.dispatchEvent(new CustomEvent("vm-edit-url"));
    });
    // Let the field's native copy/select context menu work.
    field.addEventListener("contextmenu", (event) => event.stopPropagation());
    return field;
  };

  const render = () => {
    if (!panel) return;
    hideSpaceTooltip();
    const scroll = panel.querySelector(".vm-scroll")?.scrollTop ?? 0;
    const body = el("div", "vm-scroll");
    const favLeaves = state.favs ? state.favs.children.filter((c) => !c.children) : [];
    let grid = null;
    if (state.defaultSpace) {
      grid = el("div", "vm-favs");
      favLeaves.forEach((n) => grid.append(favTile(n)));
      wireDrop(grid, {
        horizontal: true,
        accept: (d) => !(d.type === "bm" && d.node.children),
        onDrop: async (_zone, data) => insertPinned(data, (await ensureFolder("Favorites")).id, null),
      });
    }
    if (state.space) {
      const label = el("div", "vm-space");
      label.append(el("span", "vm-space-name", spacesOf.label(state.space)));
      label.append(actionButton("🎨", "Edit theme", () => window.dispatchEvent(new CustomEvent("vm-open-theme"))));
      wireDrop(label, {
        onDrop: async (_zone, data) => insertPinned(data, (state.pinned || await ensureFolder("Pinned")).id, 0),
      });
      body.append(label);
    }
    if (state.pinned) state.pinned.children.forEach((c) => body.append(pinnedNode(c, 0)));

    const taken = new Set([...state.bound.values()].map((t) => t.id));
    const blank = state.tabs.filter((t) => isBlankUrl(t.url || ""));
    const open = state.tabs.filter((t) => !isBlankUrl(t.url || "") && !taken.has(t.id));
    const listed = stacksOf.entries(open);
    shownStacks = listed.filter((e) => e.type === "stack").map((e) => e.id);
    // Clear closes the loose tabs only: a folder is a deliberate grouping.
    const loose = listed.filter((e) => e.type === "tab").map((e) => e.tab);
    const divider = el("div", "vm-divider");
    const clear = el("span", "vm-clear", "Clear");
    clear.addEventListener("click", async () => {
      if (!loose.length) return;
      if (loose.length + blank.length === state.tabs.length) await chrome.tabs.create({});
      chrome.tabs.remove(loose.map((t) => t.id));
    });
    divider.append(clear);
    wireDrop(divider, { accept: isBookmark, onDrop: (_zone, data) => unpin(data) });
    body.append(divider);
    const fresh = el("div", "vm-row vm-newtab");
    fresh.style.paddingLeft = "8px";
    fresh.append(el("span", "vm-plus", "+"), el("span", "vm-title", "New Tab"));
    fresh.addEventListener("click", () => window.dispatchEvent(new CustomEvent("vm-open-command-bar")));
    wireDrop(fresh, { accept: isBookmark, onDrop: (_zone, data) => unpin(data) });
    body.append(fresh);
    listed.forEach((e) => body.append(e.type === "stack" ? stackNode(e) : tabRow(e.tab)));

    const bar = spaceBar();
    panel.replaceChildren(currentUrlField(), ...(grid ? [grid] : []), body, ...(bar ? [bar] : []));
    body.scrollTop = scroll;
  };

  const ICON_MAX = 20000;
  const dataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  // Some favicons are multi-size .ico files (Gmail's is 26 KB): too big to keep as is, so they are
  // redrawn at 64px, enough for the 24px tiles on a Retina screen.
  const shrinkIcon = async (blob) => {
    const bitmap = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: "high" });
    const canvas = new OffscreenCanvas(64, 64);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return dataUrl(await canvas.convertToBlob({ type: "image/png" }));
  };
  const cacheIcons = async () => {
    for (const t of state.allTabs) {
      const src = t.favIconUrl;
      const origin = originOf(t.url);
      if (!src || !/^https?:/.test(origin) || icons[origin] === src || icons[origin]?.startsWith("data:")) continue;
      let value = src;
      try {
        const blob = await (await fetch(src)).blob();
        value = await dataUrl(blob);
        if (value.length >= ICON_MAX) value = await shrinkIcon(blob);
      } catch (_) {}
      if (value.length < ICON_MAX) icons[origin] = value;
    }
    store.set("icons", icons);
  };

  const STARTER_FAVORITES = [
    ["Gmail", "https://mail.google.com/"],
    ["Calendar", "https://calendar.google.com/"],
    ["Drive", "https://drive.google.com/"],
    ["YouTube", "https://www.youtube.com/"],
    ["GitHub", "https://github.com/"],
    ["Maps", "https://www.google.com/maps"],
  ];

  // A pinned link, a folder with two links, and a folder nested inside it, so the layout is visible on day one.
  const addStarterPins = async (pinnedId) => {
    if (cfg.startUrl) await chrome.bookmarks.create({ parentId: pinnedId, title: "Vivarc Guide", url: cfg.startUrl });
    const reading = await chrome.bookmarks.create({ parentId: pinnedId, title: "Reading" });
    await chrome.bookmarks.create({ parentId: reading.id, title: "Hacker News", url: "https://news.ycombinator.com/" });
    await chrome.bookmarks.create({ parentId: reading.id, title: "Wikipedia", url: "https://www.wikipedia.org/" });
    const dev = await chrome.bookmarks.create({ parentId: reading.id, title: "Dev" });
    await chrome.bookmarks.create({ parentId: dev.id, title: "MDN Web Docs", url: "https://developer.mozilla.org/" });
    await chrome.bookmarks.create({ parentId: dev.id, title: "Stack Overflow", url: "https://stackoverflow.com/" });
    openFolders.add(reading.id);
    openFolders.add(dev.id);
    saveOpen();
  };

  let triedFirstRun = false;
  const createSpace = async (tree) => {
    const bar = tree[0]?.children?.[0];
    if (!bar) return;
    const space = await chrome.bookmarks.create({ parentId: bar.id, title: cfg.spaceFolderTitle });
    const favs = await chrome.bookmarks.create({ parentId: space.id, title: "Favorites" });
    for (const [title, url] of STARTER_FAVORITES) await chrome.bookmarks.create({ parentId: favs.id, title, url });
    const pinned = await chrome.bookmarks.create({ parentId: space.id, title: "Pinned" });
    await addStarterPins(pinned.id);
  };

  const loadBookmarks = async () => {
    let tree = await chrome.bookmarks.getTree();
    if (!findSpaces(tree).length && !triedFirstRun) {
      triedFirstRun = true;
      await createSpace(tree);
      tree = await chrome.bookmarks.getTree();
    }
    state.folders = findSpaces(tree);
    state.trash = (tree[0]?.children ?? []).find((c) => c.trash === true || /^trash$/i.test(c.title)) ?? null;
  };

  // The folder of the space on screen. A workspace Vivarc meets for the first time gets its own empty Pinned folder.
  const madeFolderFor = new Set();
  const applySpace = async () => {
    const pick = () => {
      const { default: base, byId } = spacesOf.assign(state.folders, state.workspaces);
      return { base, space: state.active ? byId[state.active] ?? null : base };
    };
    let picked = pick();
    const workspace = state.workspaces.find((w) => w.id === state.active);
    if (!picked.space && workspace && picked.base && !madeFolderFor.has(workspace.id)) {
      madeFolderFor.add(workspace.id);
      const folder = await chrome.bookmarks.create({ parentId: picked.base.parentId, title: workspace.name });
      await chrome.bookmarks.create({ parentId: folder.id, title: "Pinned" });
      await loadBookmarks();
      picked = pick();
    }
    state.defaultSpace = picked.base;
    state.space = picked.space;
    state.favs = picked.base?.children.find((c) => c.children && c.title === "Favorites") ?? null;
    state.pinned = picked.space?.children.find((c) => c.children && c.title === "Pinned") ?? null;
  };

  const readWorkspaces = async () => {
    try { return (await vivaldi.prefs.get("vivaldi.workspaces.list"))?.value || []; } catch (_) { return []; }
  };
  // Spaces that live in another window, shown or parked (sorted ids): their tiles carry a dot, and a click there jumps windows.
  const readDots = async (windowId) => {
    // normal windows only: a popup's tab must never be mistaken for a window holding a space
    try {
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      return spacesOf.dotsFor(tabs, window.__vm.native?.record()?.all() ?? new Map(), windowId);
    } catch (_) { return []; }
  };
  let warnedNoRecord = false;
  const loadTabs = async () => {
    state.allTabs = await chrome.tabs.query({ currentWindow: true });
    state.workspaces = await readWorkspaces();
    state.dots = await readDots(state.allTabs[0]?.windowId);
    ({ active: state.active, tabs: state.tabs } = spacesOf.scope(state.allTabs, state.workspaces));
    // Vivaldi's record says which space this window shows; the active tab's space is the fallback when it can't be read.
    const ownWindow = state.allTabs[0]?.windowId;
    const record = window.__vm.native?.record() ?? null;
    const recorded = record && ownWindow != null ? record.activeIn(ownWindow) : null;
    if (recorded != null && state.workspaces?.length) {
      state.active = recorded;
      state.tabs = spacesOf.tabsIn(state.allTabs, recorded);
    } else if ((!record || (ownWindow != null && recorded == null)) && !warnedNoRecord) {
      // an unknown window id says nothing about the record; a missing record or a store that fails does
      warnedNoRecord = true;
      console.warn("[vivarc] Vivaldi's workspace record could not be read; using the active tab's space instead");
    }
    if (window.__vm.activeSpace !== state.active) {
      window.__vm.activeSpace = state.active;
      window.dispatchEvent(new CustomEvent("vm-active-space-changed", { detail: state.active }));
    }
  };

  // Calls inside the debounce window are merged, and a request to reload bookmarks is never lost to a later
  // tab-only refresh (at start-up the tab events used to cancel the first bookmark load, leaving the sidebar empty).
  let timer = 0;
  let wantBookmarks = false;
  let failures = 0;
  // A button held on the panel: re-renders wait for its release (released over the page, the UI never hears the
  // pointerup, hence the fallback).
  let pressing = false;
  let refreshAfterPress = false;
  let pressFallback = 0;
  const released = () => {
    clearTimeout(pressFallback);
    if (!pressing) return;
    pressing = false;
    if (refreshAfterPress) { refreshAfterPress = false; refresh(false); }
  };
  const pressed = () => {
    pressing = true;
    clearTimeout(pressFallback);
    pressFallback = setTimeout(released, 2000);
  };
  function refresh(withBookmarks) {
    wantBookmarks ||= !!withBookmarks;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (drag) { refreshAfterDrag = true; return; } // re-rendering would detach the node being dragged
      // Nor while a button is held: replacing the pressed node between mousedown and mouseup swallows the click.
      if (pressing) { refreshAfterPress = true; return; }
      // Nor while a name is being typed: re-rendering would drop the field, and its blur would commit the old name.
      // Finishing the rename refreshes. Checked again before rendering: a name may start while the tabs load.
      if (naming()) return;
      refreshAfterDrag = false;
      const bookmarks = wantBookmarks || !state.defaultSpace;
      wantBookmarks = false;
      try {
        await loadTabs();
        if (bookmarks) await loadBookmarks();
        await applySpace();
        bindTabs();
        cacheIcons();
        if (naming()) { wantBookmarks ||= bookmarks; return; } // finishing the rename refreshes again
        render();
        failures = 0;
      } catch (e) {
        console.warn("[vivarc] sidebar:", e);
        if (++failures <= 5) { wantBookmarks = bookmarks; setTimeout(() => refresh(false), 1500); }
      }
    }, 80);
  }

  // ---- placement ----
  const guardedSidebars = new WeakSet();
  const place = () => {
    const container = document.querySelector("#tabs-container.left, #tabs-container.right");
    const strip = container?.querySelector(".tab-strip");
    if (!strip) return;
    const sidebar = container.closest("#tabs-tabbar-container");
    if (sidebar && !guardedSidebars.has(sidebar)) {
      // Vivaldi delegates double-clicks to its native tab-bar handler, which
      // creates a blank tab even when a Vivarc control was clicked. Stop only
      // propagation, preserving text selection and the controls' click events.
      sidebar.addEventListener("dblclick", (event) => event.stopPropagation());
      guardedSidebars.add(sidebar);
    }
    let anchor = strip;
    while (anchor.parentElement !== container) anchor = anchor.parentElement;
    if (!panel) {
      panel = el("div");
      panel.id = "vm-panel";
      panel.addEventListener("pointerdown", pressed, true);
      panel.addEventListener("contextmenu", (e) => showMenu(e, [
        ["New Folder", async () => { await newFolder(null); }],
        ["Edit Theme…", () => window.dispatchEvent(new CustomEvent("vm-open-theme"))],
        ["Vivarc Settings…", () => window.dispatchEvent(new CustomEvent("vm-open-settings"))],
        ["New Tab", () => window.dispatchEvent(new CustomEvent("vm-open-command-bar"))],
        ["Reopen Closed Tab", () => chrome.sessions.restore()],
      ]));
      refresh(true);
    }
    anchor.classList.add("vm-strip-hidden");
    for (const row of container.children) {
      if (row === panel || row === anchor) continue;
      const bare = ![...row.querySelectorAll("button, a, [role=button], .button-toolbar")]
        .some((n) => !n.closest(".UrlBar-AddressField"));
      row.classList.toggle("vm-collapsed", bare && !!row.querySelector(".UrlBar-AddressField"));
    }
    placeProfileBar();
    if (panel.parentElement !== container || panel.nextElementSibling !== anchor) {
      container.insertBefore(panel, anchor);
    }
  };

  // Like Arc, opening the command bar scrolls the sidebar down to the new-tab area.
  window.addEventListener("vm-folders", (e) => {
    for (const id of pinLinks.folderIds(state.pinned)) e.detail === "expand" ? openFolders.add(id) : openFolders.delete(id);
    saveOpen();
    if (naming()) refresh(false); // held until the name is done, like every other re-render
    else render();
  });
  window.addEventListener("vm-command-bar-opened", () => {
    const scroller = panel?.querySelector(".vm-scroll");
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  });

  const start = () => {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; place(); });
    }).observe(document.body, { childList: true, subtree: true });
    place();
    for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved", "onImportEnded"]) {
      chrome.bookmarks[ev]?.addListener(() => refresh(true));
    }
    for (const ev of ["pointerup", "pointercancel", "dragstart", "blur"]) window.addEventListener(ev, () => setTimeout(released), true);
    // Every window runs its own sidebar and sees the tab events of all windows: only this window's events (or ones
    // that do not say, or any until this window's id is known) re-render it, so another window's page loads do not
    // keep replacing the panel under the pointer.
    let ownWindow = null;
    chrome.windows.getCurrent().then((win) => { ownWindow = win.id; }, () => {});
    // Another window switching space (a tab activated or moved there, or the window closed) can change which tiles
    // carry a dot: re-render only when the dots actually changed.
    const checkDots = async () => {
      if (ownWindow == null) return;
      if (JSON.stringify(await readDots(ownWindow)) !== JSON.stringify(state.dots || [])) refresh(false);
    };
    const SPACE_EVENTS = new Set(["onActivated", "onAttached", "onDetached", "onRemoved"]);
    for (const ev of ["onCreated", "onRemoved", "onUpdated", "onMoved", "onActivated", "onAttached", "onDetached", "onReplaced"]) {
      chrome.tabs[ev]?.addListener((...args) => {
        const id = spacesOf.eventWindow(ev, args);
        if (id == null || ownWindow == null || id === ownWindow) refresh(false);
        else if (SPACE_EVENTS.has(ev)) checkDots();
      });
    }
    chrome.windows.onRemoved?.addListener(() => checkDots());
    setInterval(async () => {
      const brief = (list) => JSON.stringify(list.map((w) => [w.id, w.name, w.emoji, w.icon]));
      if (brief(await readWorkspaces()) !== brief(state.workspaces)) refresh(false);
      else checkDots();
    }, 3000);
    try {
      vivaldi.runtimePrivate.onProfilesUpdated.addListener(loadProfiles);
      window.__vm.onShortcut((key) => {
        const path = window.__vm.spaces.pathForShortcut(state.profiles, key);
        if (path) openProfile(path);
      });
    } catch (e) {
      console.warn("[vivarc] profile switching unavailable:", e);
    }
    loadProfiles();
    console.log("[vivarc] sidebar started");
  };

  const init = async () => {
    if (!(await window.__vm.ready)) return;
    (await store.get("open", [])).forEach((id) => openFolders.add(id));
    (await store.get("stacks:closed", [])).forEach((id) => closedStacks.add(id));
    icons = await store.get("icons", {});
    start();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
