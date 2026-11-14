// Closing a space's last tab keeps you in that space, empty, with the command bar open (Task 9c; Byron, 2026-11-14,
// decision D3: the upstream and Arc behaviour, KASOGIT/vivarc#118 and #119, which reverses the earlier decline of #75).
// Before, the window went to its default space: Chromium puts another tab on screen when the tab on screen closes, and
// with no tab of the space left, repair 1 switched the window to default.
// Every window runs this for its own tab on screen. When that tab (a page, not a blank tab) closes and the window holds no
// other page of its space, the space gets a blank tab (Vivaldi files a new tab in the window's recorded space, B1; or its
// switch into an empty space makes one, A7), it is shown, and the command bar opens on it, keeping it, so Escape stays in
// the empty space (20-command-bar.js keepTarget). It runs under the repair busy mark, so no repair acts on the moment the
// space has no tab; after it the window is recorded on the space and shows its blank tab, which no repair changes.
// Not for: a window that is closing, a deleted space (rule 1 takes the window to default), a tab moved out of the window
// (tear-off, a drop into another window, chrome.tabs.move: onDetached, still repair 1), a blank tab closing (the bar's own
// Escape), and anything under another gesture's busy mark (deleting a space, moving one).
(() => {
  const ws = () => window.__vm.workspaces;
  const NONE = { kind: "none" };
  const SETTLE_MS = 150; // Vivaldi's own close (Ctrl+W) may make the space's start page itself: looked at again after this

  // Pure. closed: { space, page } of this window's tab that was on screen (page: not a blank tab); now: the space Vivaldi's
  // record names for the window now (null: unreadable); known: the ids of the spaces that exist (null: unreadable); tabs:
  // the window's tabs now; busy: another gesture is under way.
  // -> { kind: "none" } | { kind: "create" } (no tab of the space is left and the window is still recorded on it: a new
  // tab, which Vivaldi files in that space) | { kind: "switch", space } (none left and the record moved off it: Vivaldi's
  // switch into an empty space makes its start page) | { kind: "bar", tab, switch } (only blank tabs of it are left: its
  // most recent one is shown, through Vivaldi's switch when the record moved off the space).
  const decide = ({ closed, now, known, tabs, busy } = {}) => {
    if (busy || !closed?.page || now == null) return NONE;
    const space = closed.space || 0;
    if (space && (!Array.isArray(known) || !known.includes(space))) return NONE;
    const own = (tabs || []).filter((t) => ws().of(t) === space);
    if (own.some((t) => !ws().isBlank(t))) return NONE; // a page of the space is left: repair 2 shows it, as before
    if (!own.length) return now === space ? { kind: "create" } : { kind: "switch", space };
    return { kind: "bar", tab: ws().recentTab(own, space).id, switch: now !== space, space };
  };

  const api = { decide };
  window.__vm.emptySpace = api;

  const start = async () => {
    if (!(await window.__vm.ready)) return;
    let me = null;
    try { me = (await chrome.windows.getCurrent()).id; } catch (_) { return; }
    // This window's tab on screen, { id, space, page }, and the one before it for a moment: when the tab on screen closes,
    // Chromium may put another on screen (onActivated) before the close is reported (onRemoved).
    // What each of this window's tabs is ({ id, space, page }), kept from its own events: a tab activated and closed before
    // its lookup answers is still known (review 9c, minor 7).
    const info = new Map();
    const learn = (tab) => { if (tab?.id != null && tab.windowId === me) info.set(tab.id, { id: tab.id, space: ws().of(tab), page: !ws().isBlank(tab) }); };
    let shown = null, previous = null;
    const known = (id) => info.get(id) ?? null;
    chrome.tabs.query({ windowId: me }).then((tabs) => { for (const t of tabs) { learn(t); if (t.active && !shown) shown = { id: t.id }; } }, () => {});
    chrome.tabs.onCreated?.addListener(learn);
    chrome.tabs.onAttached?.addListener((id, a) => { if (a?.newWindowId === me) chrome.tabs.get(id).then(learn, () => {}); });
    chrome.tabs.onDetached?.addListener((id, d) => { if (d?.oldWindowId === me) info.delete(id); });
    chrome.tabs.onActivated?.addListener(({ tabId, windowId }) => {
      if (windowId !== me) return;
      if (shown && shown.id !== tabId) previous = { id: shown.id, until: Date.now() + 1000 };
      shown = { id: tabId };
      if (!info.has(tabId)) chrome.tabs.get(tabId).then(learn, () => {});
    });
    chrome.tabs.onUpdated?.addListener((id, change, tab) => learn(tab));
    const snapshot = async () => {
      const native = window.__vm.native;
      const record = native?.hasSwitch?.() ? native.record() : null;
      return { now: record ? record.activeIn(me) : null, known: await native?.spaceIds?.() ?? null, tabs: await chrome.tabs.query({ windowId: me }) };
    };
    const busy = () => !!window.__vm.spaceRepair?.busy?.();
    const react = async (closed) => {
      if (busy()) return;
      if (decide({ closed, ...(await snapshot()) }).kind === "none") return;
      const end = window.__vm.spaceRepair?.gesture?.() ?? null;
      try {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const plan = decide({ closed, ...(await snapshot()) });
        const native = window.__vm.native;
        let tabId = null;
        if (plan.kind === "create") {
          const made = await chrome.tabs.create({ windowId: me, active: true });
          tabId = made.id;
          // Vivaldi files it in the recorded space (B1); should it not, it is put there (it is on screen: a switch, G4)
          if (ws().of(await chrome.tabs.get(tabId)) !== (closed.space || 0)) await native.setSpace(tabId, closed.space || 0, { windowId: me });
        } else if (plan.kind === "switch") {
          await native.switchTo(me, plan.space);
          // Vivaldi makes the empty space's start page just after its switch resolves: looked for up to 1.5 s
          for (let look = 0; look < 15 && tabId == null; look++) {
            if (look) await new Promise((resolve) => setTimeout(resolve, 100));
            tabId = (await chrome.tabs.query({ windowId: me })).find((t) => t.active && ws().of(t) === plan.space)?.id ?? null;
          }
        } else if (plan.kind === "bar") {
          tabId = plan.tab;
          if (plan.switch) await native.switchTo(me, closed.space || 0);
          if (!(await chrome.tabs.get(tabId)).active) await chrome.tabs.update(tabId, { active: true });
        } else return;
        // Vivaldi's own delete holds no Vivarc mark: a space deleted meanwhile must not keep the new tab (task 8y's dead id)
        const known = await native.spaceIds?.();
        if (closed.space && tabId != null && Array.isArray(known) && !known.includes(closed.space)) {
          await native.setSpace(tabId, 0, { windowId: me }).catch(() => {});
          return;
        }
        console.log(`[vivarc] empty space: window ${me} stays in ${closed.space ? `space ${closed.space}` : "its default space"} (${plan.kind})`);
        if (tabId != null) await window.__vm.openEmptySpace?.(tabId, me);
      } catch (error) {
        console.warn("[vivarc] empty space:", error);
      } finally { end?.(); }
    };
    chrome.tabs.onRemoved?.addListener((tabId, info) => {
      if (info?.windowId !== me || info.isWindowClosing) return;
      const wasShown = shown?.id === tabId || (previous?.id === tabId && previous.until > Date.now());
      const closed = wasShown ? known(tabId) : null;
      info.delete(tabId);
      if (shown?.id === tabId) shown = null;
      if (previous?.id === tabId) previous = null;
      if (closed) react(closed).catch(() => {});
    });
  };
  start();
})();
