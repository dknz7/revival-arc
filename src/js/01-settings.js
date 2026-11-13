// Vivarc settings: switches that apply live, saved per profile (like the theme) and shared by the profile's windows.
// Precedence: what the user saved, then the install config (~/.vivarc/config.json), then the default.
(() => {
  // onClass / offClass: a marker class on #browser while the setting is on / off (the stylesheet reacts to it).
  const SCHEMA = [
    { key: "showUrl", label: "Show URL", hint: "Show the current page URL above favorites. Click it to edit it in the command bar.",
      default: true, fromConfig: (c) => c.showUrl, offClass: "vm-no-url" },
    { key: "glass", label: "Liquid glass", hint: "Translucent, blurred sidebar, menus, command bar and dialogs, after Apple's Liquid Glass. Follows Reduce Transparency and Increase Contrast.",
      default: false, onClass: "vm-glass" },
    { key: "glassOpacity", type: "range", min: 15, max: 95, step: 1, default: 55, unit: "%", needs: "glass", cssVar: "--vm-glass-opacity",
      label: "Glass opacity", hint: "From clear to frosted: how much of the surface colour shows through the glass.", low: "Clear", high: "Frosted" },
    { key: "spaceBar", label: "Space bar", hint: "The row of space tiles under the sidebar.", default: true, offClass: "vm-no-space-bar" },
    { key: "compactBottomBar", label: "Compact bottom bar", hint: "A tighter row for the profile avatars and downloads.", default: true,
      fromConfig: (c) => c.compactBottomBar, onClass: "vm-compact-bottom" },
    { key: "searchSuggestions", label: "Search suggestions", hint: "Show suggestions from your default search engine, when its Suggest URL is configured.", default: true,
      fromConfig: (c) => (c.suggestions === undefined ? undefined : ["default", "ddg"].includes(c.suggestions)) },
    { key: "diaLayout", label: "Dia layout", hint: "A slim row over the page for back, forward, reload, the page's site and title, and the window buttons, with the sidebar up to the top. Off puts your own toolbar and window frame back.",
      default: false, onClass: "vm-dia" },
    { key: "cleanupDaily", label: "Clean up tabs daily (idle 7 days)", hint: "Once a day, close the tabs you have not used for 7 days, in every space. Pinned tabs, favorites, tabs on screen and tabs playing sound stay. Cleaned tabs wait in New Tab menu > Recently Cleaned for 30 days.",
      default: false },
  ];

  const resolve = (schema, config, saved) => Object.fromEntries(schema.map((s) => {
    const mine = saved?.[s.key];
    if (s.type === "range") {
      return [s.key, typeof mine === "number" && Number.isFinite(mine) ? Math.min(s.max, Math.max(s.min, Math.round(mine))) : s.default];
    }
    const fromConfig = s.fromConfig?.(config || {});
    const base = typeof fromConfig === "boolean" ? fromConfig : s.default;
    return [s.key, typeof mine === "boolean" ? mine : base];
  }));

  // CSS custom properties for the range settings, set on #browser.
  const vars = (schema, values) => Object.fromEntries(schema.filter((s) => s.cssVar).map((s) => [s.cssVar, `${values[s.key]}${s.unit || ""}`]));

  const classes = (schema, values) => Object.fromEntries(schema.flatMap((s) => [
    ...(s.onClass ? [[s.onClass, !!values[s.key]]] : []),
    ...(s.offClass ? [[s.offClass, !values[s.key]]] : []),
  ]));

  const api = { SCHEMA, resolve, classes, vars };
  window.__vm.settings = api;
  if (!window.__vm.store) return;

  const { store, config } = window.__vm;
  const listeners = new Set();
  const channel = new BroadcastChannel("vivarc-settings");
  let saved = {};
  // A private window has a store and channel of its own (off the record), so the normal windows' settings never reach it.
  // Its Dia layout follows theirs instead, read from Vivaldi's prefs (15-dia.js, dia.inherited), and a switch flipped in it
  // stays in that window: never saved, never sent. `local` holds those values; `mine` the ones the user set in this window,
  // which stop following the normal windows.
  const privateWindow = !!globalThis.chrome?.extension?.inIncognitoContext;
  const WINDOW_ONLY = privateWindow ? ["diaLayout"] : [];
  let local = {};
  const mine = new Set();
  let values = resolve(SCHEMA, config, saved);

  const apply = (browser) => {
    for (const [name, on] of Object.entries(classes(SCHEMA, values))) browser.classList.toggle(name, on);
    for (const [name, value] of Object.entries(vars(SCHEMA, values))) browser.style.setProperty(name, value);
  };
  const update = (next) => {
    saved = next || {};
    values = resolve(SCHEMA, config, { ...saved, ...local });
    const browser = document.querySelector("#browser");
    if (browser) apply(browser);
    // Each listener on its own: one that throws does not keep the change from the rest.
    listeners.forEach((fn) => { try { fn(values); } catch (error) { console.warn("[vivarc] settings listener:", error); } });
  };
  const persist = () => { store.set("settings", saved); channel.postMessage(saved); };
  // The normal windows' value for each window-only key the user has not set here: whether any changed. Never throws.
  const inherit = async () => {
    let changed = false;
    try {
      const from = window.__vm.dia?.inherited;
      if (!WINDOW_ONLY.length || typeof from !== "function") return false;
      const on = await from();
      if (typeof on !== "boolean") return false;
      for (const key of WINDOW_ONLY) if (!mine.has(key) && local[key] !== on) { local[key] = on; changed = true; }
    } catch (error) { console.warn("[vivarc] settings: private window:", error); }
    return changed;
  };

  Object.assign(api, {
    get: (key) => values[key],
    all: () => ({ ...values }),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: (key, value) => {
      if (WINDOW_ONLY.includes(key)) { local[key] = value; mine.add(key); update(saved); return; }
      update({ ...saved, [key]: value });
      persist();
    },
    // A private window reads the normal windows' values again first, so its layout does not switch off and back on.
    reset: () => {
      const done = () => { update({}); persist(); };
      local = {};
      mine.clear();
      if (WINDOW_ONLY.length) inherit().then(done); else done();
    },
  });

  channel.onmessage = (e) => update(e.data);
  window.__vm.onMark(apply);
  // A private window follows the normal windows while it is open: a switch there changes the prefs it reads. Vivaldi sets
  // them one by one, so it reads them once they have settled.
  if (WINDOW_ONLY.length) {
    let soon = 0;
    try {
      vivaldi.prefs.onChanged?.addListener(() => {
        clearTimeout(soon);
        soon = setTimeout(() => inherit().then((changed) => { if (changed) update(saved); }), 150);
      });
    } catch (error) { console.warn("[vivarc] settings: private window:", error); }
  }
  // Resolves once the saved settings are in: until then the values are the defaults, not the user's.
  api.loaded = store.get("settings", {}).then(async (next) => { await inherit(); update(next); });
})();
