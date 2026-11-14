// A short transition when this window switches space (ported from KASOGIT/vivarc#85, 66e9719; Byron's taste call,
// 2026-11-14): the sidebar's list fades and rises into place over 220 ms and the page fades in over 180 ms. It only
// animates surfaces already on screen with the Web Animations API (opacity and transform, which the compositor runs), so
// the switch itself is never delayed or waited on; a new switch cancels a running one, and Reduce Motion turns it off.
// It follows the sidebar's own "the space on screen changed" event (vm-active-space-changed, 10-sidebar.js), which comes
// from Vivaldi's record, so every way of switching gets it and a window's first look at its space does not. The list is
// animated once the sidebar has drawn the new space (vm-sidebar-rendered), and only the list (.vm-scroll): the address
// field, the favorites and the space bar stay still.
(() => {
  const SIDEBAR_MS = 220;
  const PAGE_MS = 180;
  const RENDER_WAIT_MS = 1500; // the list is drawn within a moment of the switch; later, it is not this switch's any more
  // Whether a change of the space on screen animates: a real change from a known space, and Reduce Motion off.
  const wants = ({ previous, next, reduced }) => previous != null && next != null && previous !== next && !reduced;
  window.__vm.spaceMotion = { wants, SIDEBAR_MS, PAGE_MS, last: null };
  if (!window.__vm.store || typeof window.addEventListener !== "function") return;

  let shown = window.__vm.activeSpace ?? null;
  let running = [];
  let pending = null; // { space, until }: the list to animate once the sidebar has drawn `space`
  const reducedMotion = () => { try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
  const run = (node, frames, options) => {
    try {
      if (!node?.animate) return;
      const animation = node.animate(frames, options);
      running.push(animation);
      animation.finished?.then(() => { running = running.filter((a) => a !== animation); }, () => {});
    } catch (error) { console.warn("[vivarc] space transition:", error); }
  };
  window.addEventListener("vm-active-space-changed", (event) => {
    const previous = shown;
    const next = event.detail;
    shown = next;
    running.forEach((animation) => { try { animation.cancel(); } catch (_) {} });
    running = [];
    pending = null;
    const reduced = reducedMotion();
    const go = window.__vm.cssLoaded && wants({ previous, next, reduced });
    window.__vm.spaceMotion.last = { at: Date.now(), previous, next, reduced, animated: !!go };
    if (!go) return;
    // The page column: in the Dia layout it is a rounded card (#webview-container), faded whole so its corners go with it.
    run(document.querySelector("#browser.vm-dia #webview-container") || document.querySelector("#webpage-stack"),
      [{ opacity: 0.9 }, { opacity: 1 }], { duration: PAGE_MS, easing: "ease-out" });
    pending = { space: next, until: Date.now() + RENDER_WAIT_MS };
  });
  window.addEventListener("vm-sidebar-rendered", (event) => {
    if (!pending || event.detail !== pending.space || Date.now() > pending.until) return;
    pending = null;
    run(document.querySelector("#vm-panel .vm-scroll"),
      [{ opacity: 0.72, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: SIDEBAR_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  });
})();
