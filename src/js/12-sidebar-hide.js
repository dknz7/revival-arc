// Hides and shows this window's sidebar (Vivaldi's tab bar), on Ctrl+S (Cmd+S on a Mac) and for the Dia layout's button
// (15-dia.js). Vivaldi's own hide is one pref for the whole profile (vivaldi.tabs.visible), which hides every window at
// once; this is a class on this window's #browser instead (vivarc.css), so other windows are untouched. The state lives
// in this window only: it is not saved, and a restarted Vivaldi opens its windows with the sidebar shown.
// Every window hears every key (measured on 8.2), so each acts only on a key pressed in it (see pressedHere).
(() => {
  const CLASS = "vm-sidebar-hidden";
  const TABS = "vivaldi.tabs.visible";

  // Was the key pressed in this window? The event names the Vivaldi window it was pressed in, which is window.vivaldiWindowId
  // here (measured on 8.2). Without both ids the window Chromium says is focused is the one.
  const pressedHere = (eventWindow, ownWindow, focused) =>
    typeof eventWindow === "number" && typeof ownWindow === "number" ? eventWindow === ownWindow : !!focused;

  const listeners = new Set();
  let classHidden = false; // this window's own hide (the class)
  let prefHidden = false; // Vivaldi's own hide, from its menu or a command of its own: every window, not this one's business
  let warned = false;
  const warn = (error) => {
    if (warned) return;
    warned = true;
    console.warn("[vivarc] sidebar hide:", error);
  };
  const hidden = () => classHidden || prefHidden;
  const onChange = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const notify = () => listeners.forEach((fn) => { try { fn(hidden()); } catch (error) { warn(error); } });
  // Vivaldi re-renders #browser's class list; the core re-applies the marker classes (and calls this) when that happens.
  const apply = (browser) => {
    const target = browser || document.querySelector("#browser");
    if (target) target.classList.toggle(CLASS, classHidden);
  };

  // Hidden by this window or by Vivaldi's pref: shows it. Vivaldi's pref is a profile-wide setting, so showing a sidebar
  // it hid shows it in every window (a per-window show would need every other window to hide itself by class, and could
  // not tell a window it should hide from one Vivaldi's own menu just showed). Shown: hides it in this window only.
  const toggle = async () => {
    if (hidden()) {
      classHidden = false;
      if (prefHidden) {
        prefHidden = false;
        try { await vivaldi.prefs.set({ path: TABS, value: true }); } catch (error) { warn(error); }
      }
    } else {
      classHidden = true;
    }
    apply();
    notify();
  };

  window.__vm.sidebarHide = { toggle, hidden, onChange, pressedHere };
  if (!window.__vm.onShortcut) return;

  window.__vm.onMark(apply);
  const readPref = () => vivaldi.prefs.get(TABS).then((pref) => {
    const now = (pref?.value ?? pref) === false;
    if (now !== prefHidden) { prefHidden = now; notify(); }
  }, warn);
  try {
    readPref();
    vivaldi.prefs.onChanged?.addListener((path) => { if (path === TABS) readPref(); });
  } catch (error) { warn(error); }

  const KEY = window.__vm.normalise(window.__vm.shortcut("meta+s"));
  window.__vm.onShortcut((key, _combo, pressedIn) => {
    if (key !== KEY || !window.__vm.cssLoaded) return;
    const own = window.vivaldiWindowId;
    if (typeof pressedIn === "number" && typeof own === "number") {
      if (pressedIn === own) toggle();
      return;
    }
    chrome.windows.getCurrent().then((win) => { if (pressedHere(pressedIn, own, win.focused)) toggle(); }, warn);
  });
  console.log("[vivarc] sidebar hide started");
})();
