// Vivarc's own messages ("Copied Current URL" when Vivaldi's Cmd+Shift+C runs, the tear-off's "Opened in a new window" with
// Undo, the sidebar's "Could not..." lines): a toast in Vivarc's notifications (17-notify.js), where a site's question and
// the other toasts drop from, under the breadcrumb or the sidebar's URL bar. One plain message at a time (a new one replaces
// the last, as before), and one with a button (Undo), so a later message never takes an Undo away. A message belongs to
// the tab that was active when it came (it hides on a switch and comes back), in the window it came in.
(() => {
  const SHARE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 12H5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-1"/></svg>';

  // `action` ({ label, run }) adds a button that runs `run` and dismisses the toast; `ms` is how long it stays.
  const show = (message = "Copied Current URL", action = null, ms = 2200) => {
    if (!window.__vm.cssLoaded || !window.__vm.notify) return;
    const text = document.createElement("span");
    text.className = "vm-toast-text";
    text.textContent = message;
    const run = () => { try { Promise.resolve(action.run()).catch((error) => console.warn("[vivarc] toast action:", error)); } catch (error) { console.warn("[vivarc] toast action:", error); } };
    const note = window.__vm.notify.add({ id: action ? "vm-toast-action" : "vm-toast", tab: "active", type: "message", icon: SHARE_SVG, text, ms, fresh: true, cls: "vm-toast",
      actions: action ? [{ label: action.label, cls: "vm-toast-action", run }] : [], close: false });
    note?.el?.classList.add("vm-toast");
  };

  // detail: a message, or { message, action: { label, run }, ms }
  window.addEventListener("vm-toast", (e) => {
    const d = e.detail;
    if (d && typeof d === "object") show(d.message || undefined, d.action || null, d.ms || undefined);
    else show(d || undefined);
  });
  // Every window hears every key: only the one it was pressed in says so (12-sidebar-hide.js, pressedHere).
  window.__vm.onShortcut((key, _combo, pressedIn) => {
    if (key !== window.__vm.normalise(window.__vm.shortcut("meta+shift+c"))) return;
    const here = window.__vm.sidebarHide?.pressedHere;
    if (!here || here(pressedIn, window.vivaldiWindowId, document.hasFocus())) show();
  });
})();
