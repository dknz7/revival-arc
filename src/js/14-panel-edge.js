// Vivaldi's own panel, on the right and auto-hidden (05-bootstrap.js sets it up), slides in when the pointer reaches the
// window's right edge. Vivaldi decides that in its native code (vivaldi_browser_window.cc, ReportMousePosition, 8.2): a
// mouse move inside the window's last 4 px (10 px in a window that is not maximised), away from the 34 px corners. It
// only sees moves while the pointer is over the window, so where the edge does not stop the pointer (another monitor
// on that side) the pointer mostly passes those 4 px between two moves and the panel does not come; it is reliable only
// on a monitor with nothing to its right. This listens to the same moves in this window's own coordinates and, at the same edge, sends
// Vivaldi's own edge event (windowPrivate.onMouseCloseToEdge, "right") to Vivaldi's own listener: Vivaldi then reveals
// the panel, and hides it again, exactly as for its own edge, with its own checks (auto-hide on, no menu or dialog open,
// not editing the toolbar). The event names a window, so only this window's panel moves.
// Only moves over the window's bare background count (the gap right of the page: Vivaldi's 6 px border in a window
// that is not maximised, the Dia page card's 8 px margin, and in the Arc layout maximised a 6 px gap vivarc.css makes for
// it), never over the page, its scrollbar or a control, so nothing at that edge loses a click or a drag. Where nothing
// stops the pointer, it has to pause in that gap (DWELL, below; or Vivaldi's own 4 px): a wider target than Vivaldi's
// alone, not a catch for a pointer that flies straight past, which would pop the panel on every move to the next monitor.
// A pause is "no move out of the gap and no leaving the window" for DWELL ms; a move from the gap straight back onto the
// page is not heard here (the page hears it), so a pointer that dips into the gap and back that fast still reveals.
(() => {
  const REACH = 10; // Vivaldi's reach in a window that is not maximised
  const CORNER = 34; // Vivaldi's dead corners
  // Window background, not anything drawn on it: #browser's own border, and #main / its .inner around the page card.
  const BACKGROUND = new Set(["browser", "main", "inner", "app", "body", "html"]);

  // Is the pointer at the right edge, as Vivaldi's own edge test reads it? Client coordinates of this window only.
  const atEdge = ({ x, y, width, height, buttons }) =>
    buttons === 0 && x >= width - REACH && x < width && y >= CORNER && y < height - CORNER;
  // Vivaldi reports the edge once per arrival at it, not on every move there; so does this. `here`: this move is on the
  // edge's background (so sliding off a control there onto it is an arrival too). This page hears no moves over the web
  // page (they go to the page), so a pointer that left the edge that way is seen leaving only by the pause: an edge move
  // more than PAUSE ms after the last one is an arrival too. Returns whether this move is an arrival, and the new memo.
  const PAUSE = 1000;
  const step = (memo, here, now) => ({
    arrived: !!here && (!memo.inside || now - memo.lastAt > PAUSE),
    memo: { inside: !!here, lastAt: here ? now : memo.lastAt },
  });
  // Should an arrival reveal the panel: the panel is on the right and auto-hidden (Vivaldi wraps it in a right-hand
  // auto-hide wrapper), not already showing, the window not full screen.
  const wanted = ({ wrapper, holdsPanel, shown, fullscreen }) => !!(wrapper && holdsPanel && !shown && !fullscreen);
  const backgroundOf = (target) => {
    if (!target || target.nodeType !== 1) return false;
    const key = target.id || (target.classList?.contains("inner") && target.parentElement?.id === "main" ? "inner" : target.tagName.toLowerCase());
    return BACKGROUND.has(key);
  };

  // A pointer only passing through (a fling onto the next monitor) must not pop the panel: an arrival counts once the
  // pointer has paused in the gap for DWELL ms, that is, no move out of the gap and no leaving the window in that time.
  const DWELL = 80;

  window.__vm.panelEdge = { atEdge, step, wanted, REACH, CORNER, PAUSE, DWELL };
  if (!window.__vm.onShortcut) return; // loaded for a test

  let warned = false;
  const warn = (error) => {
    if (warned) return;
    warned = true;
    console.warn("[vivarc] panel edge:", error);
  };
  // Vivaldi's edge event on the background page (Vivaldi's listener lives there). Looked up at each use, so a background
  // page not ready yet at start-up only delays this, and it is tried again at the next arrival.
  const edgeEvent = () => {
    try { return chrome.extension.getBackgroundPage?.()?.vivaldi?.windowPrivate?.onMouseCloseToEdge; } catch (_) { return null; }
  };

  const reveal = () => {
    if (!window.__vm.cssLoaded) return;
    const browser = document.querySelector("#browser");
    const wrapper = browser?.querySelector(":scope > .auto-hide-wrapper.right");
    const go = wanted({ wrapper: !!wrapper, holdsPanel: !!wrapper?.querySelector("#panels-container"),
      shown: !!wrapper?.classList.contains("show"), fullscreen: !!browser?.classList.contains("fullscreen") });
    const id = window.vivaldiWindowId;
    if (!go || typeof id !== "number") return;
    const event = edgeEvent();
    if (typeof event?.dispatch !== "function") {
      warn("Vivaldi's edge event cannot be sent (yet); its own edge test is all there is for now");
      return;
    }
    try { event.dispatch(id, { mousePosition: "right" }); } catch (error) { warn(error); }
  };

  let memo = { inside: false, lastAt: 0 };
  let dwell = null;
  const cancel = () => { clearTimeout(dwell); dwell = null; };
  const onMove = (e) => {
    const here = atEdge({ x: e.clientX, y: e.clientY, width: window.innerWidth, height: window.innerHeight, buttons: e.buttons }) &&
      backgroundOf(e.target);
    const next = step(memo, here, Date.now());
    memo = next.memo;
    if (!here) cancel();
    if (!next.arrived) return;
    cancel();
    dwell = setTimeout(() => { dwell = null; if (memo.inside) reveal(); }, DWELL);
  };
  document.addEventListener("mousemove", onMove, { capture: true, passive: true });
  // The pointer left the window (not just one element inside it: those mouseleaves do not reach a listener on the document
  // outside the capture phase, and are checked off anyway).
  document.addEventListener("mouseleave", (e) => {
    if (e.target !== document && e.target !== document.documentElement) return;
    memo = { ...memo, inside: false };
    cancel();
  }, { passive: true });
  // The same, heard another way: a mouseout with nowhere to go (relatedTarget null) is the pointer leaving the window from
  // whatever element it was over, and the capture phase hears it whatever that element does with the event. It makes the
  // pause end even where the document's own mouseleave is not delivered (a fling off the edge onto the next monitor).
  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget !== null) return;
    memo = { ...memo, inside: false };
    cancel();
  }, { capture: true, passive: true });
  console.log("[vivarc] panel edge started");
})();
