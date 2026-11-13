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
  // Where the sidebar was when this window hid it: a popup of the address field (which lives in the hidden tab bar) floats
  // there, as it does with the sidebar shown (vivarc.css). Measured as it hides, since a hidden tab bar measures nothing.
  let side = null; // { left, right, top, width } in px
  const measure = () => {
    const bar = document.querySelector("#tabs-tabbar-container")?.getBoundingClientRect();
    if (bar && bar.width > 0) side = { left: bar.left, right: window.innerWidth - bar.right, top: bar.top, width: bar.width };
  };
  // Vivaldi re-renders #browser's class list; the core re-applies the marker classes (and calls this) when that happens.
  const apply = (browser) => {
    const target = browser || document.querySelector("#browser");
    if (!target) return;
    target.classList.toggle(CLASS, classHidden);
    if (!side) return;
    for (const [name, value] of Object.entries(side)) {
      const px = `${Math.round(value)}px`;
      if (target.style.getPropertyValue(`--vm-side-${name}`) !== px) target.style.setProperty(`--vm-side-${name}`, px);
    }
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
      try { measure(); } catch (error) { warn(error); }
      classHidden = true;
    }
    apply();
    notify();
  };

  window.__vm.sidebarHide = { toggle, hidden, onChange, pressedHere };
  if (!window.__vm.onShortcut) return;

  window.__vm.onMark?.(apply);
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
    const act = (focused) => { if (pressedHere(pressedIn, own, focused)) toggle(); };
    if (typeof pressedIn === "number" && typeof own === "number") act(false);
    else chrome.windows.getCurrent().then((win) => act(win.focused), warn);
  });

  // The keys that ask for the address field (Ctrl+L, Cmd+L, F6, Alt+D, as 20-command-bar.js counts them). With this
  // window's sidebar hidden the field is in the hidden tab bar and cannot take the cursor, so the command bar opens to
  // edit the address instead, as a click on the Dia layout's breadcrumb does (vm-edit-url), and the sidebar stays hidden.
  // Measured on 8.3 on Windows (not on a Mac, where Cmd+L takes the same path): Vivaldi's shortcut comes as
  // onKeyboardShortcut in the window it was pressed in, wherever the cursor is. With the cursor in the UI the UI's keydown
  // comes first, and preventDefault() there stops Vivaldi's own handling
  // (it would try the hidden field); with the cursor in the page there is no such keydown, and Vivaldi's try on the
  // hidden field does nothing (no focus, then or once the sidebar is back). Vivaldi's own hide (its pref) is not this:
  // it then shows an address field in the top row, which Ctrl+L reaches. Nor is a field floating for one of its popups
  // (vivarc.css): it can take the cursor, so the key is Vivaldi's. The keys are taken while hidden even if the user has
  // bound them to something else in Vivaldi.
  const ASK = new Set(["ctrl+l", "l+meta", "f6", "alt+d"].map((k) => window.__vm.normalise(k)));
  const askKey = (e) => (e.key === "F6" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) ||
    ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === "l") || (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key?.toLowerCase() === "d");
  const fieldShown = () => {
    const field = document.querySelector("#tabs-tabbar-container .UrlBar-AddressField");
    const box = field?.getBoundingClientRect();
    return !!box && box.width > 0 && box.height > 0 && getComputedStyle(field).visibility === "visible";
  };
  const wantsBar = () => classHidden && !!window.__vm.cssLoaded && !!document.querySelector("#browser.vm-on") && !fieldShown();
  let editAt = 0;
  const editInBar = () => {
    if (Date.now() - editAt < 400) return; // one key press, one bar
    editAt = Date.now();
    if (document.querySelector("#vm-cmd")) return; // already open: it keeps what the user has typed
    window.dispatchEvent(new CustomEvent("vm-edit-url"));
  };
  window.addEventListener("keydown", (e) => {
    try {
      if (e.repeat || !askKey(e) || !wantsBar()) return;
      e.preventDefault();
      editInBar();
    } catch (error) { warn(error); }
  }, true);
  window.__vm.onShortcut((key, _combo, pressedIn) => {
    try {
      if (!ASK.has(key) || !wantsBar()) return;
      const own = window.vivaldiWindowId;
      if (!pressedHere(pressedIn, own, document.hasFocus())) return;
      editInBar();
    } catch (error) { warn(error); }
  });
  console.log("[vivarc] sidebar hide started");
})();
