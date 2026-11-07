# How Vivarc works

Vivaldi's UI is a web page (`window.html`). Vivarc adds one script and one stylesheet to it.

| Piece | Where it lives | What it does |
|---|---|---|
| CSS | Embedded in `vivarc.js` and added to the UI as a `<style>` element (source: `src/css/vivarc.css`) | Styles. Every rule is scoped to `#browser.vm-on`, a class the JS adds. No CSS-mods folder or browser flag is needed, and it never conflicts with your own CSS mods. |
| JS | `<Vivaldi.app>/.../vivaldi/vivarc.js`, referenced from `window.html` by one marked block | The sidebar, command bar, toast and theme editor. Rebuilt from `src/js/` by `vivarc.py apply`. |
| Data | A bookmarks folder with `Favorites` and `Pinned` subfolders (created on first run) | Your favorites and pinned folders. Plain bookmarks: they sync, export and back up like any others. |
| Settings | `~/.vivarc/config.json` | See below. |
| State | `~/.vivarc/state.json`, `~/.vivarc/backup/` | What the installer changed and the original values, used by `uninstall`. |

## Why a Vivaldi update removes the JS

An update replaces `Vivaldi.app`, including `window.html`. Run `./vivarc.py update` after updating: it pulls (git checkout) or downloads the latest release when there is one, then re-runs `install`. The installer leaves `~/Applications/Update Vivarc.app`, which opens `~/.vivarc/Update Vivarc.command` in Terminal; that script runs `update` (it quits Vivaldi) and reopens Vivaldi. `~/Applications/Uninstall Vivarc.app` does the same for `~/.vivarc/Uninstall Vivarc.command`, which runs `uninstall`. They are generated locally (the app by `osacompile`, ad-hoc signed), so macOS does not quarantine them, the app can sit in the Dock, and `uninstall` removes them all. The optional reminder (`vivarc.py reminder on`) is a LaunchAgent, `~/Library/LaunchAgents/com.vivarc.reminder.plist`, that runs `vivarc.py remind` at login, every hour and when Vivaldi's `Info.plist` changes. `remind` only reads: if `window.html` has lost the Vivarc block (or `vivarc.js` is missing) it shows one dialog, at most every 12 hours, and on yes opens the update script in Terminal. When Vivarc is in place it also asks GitHub for the latest release tag (a redirect, nothing is downloaded) and, if that is newer than the installed version, shows one dialog per release (remembered in `~/.vivarc/offered`) with the same yes path. A git clone (Revival Arc's fork) is never offered a release: it updates with `git pull` from its own origin, so upstream's release number is not an update for it. It still gets the "Vivaldi was updated" dialog. A background job cannot do the update itself: macOS only lets a terminal you have granted App Management edit `Vivaldi.app`.
`./vivarc.py status` tells you whether the JS is in place. Until you re-apply, Vivaldi simply looks like normal Vivaldi.

## Configuration

`~/.vivarc/config.json`, then run `./vivarc.py apply`:

```json
{
  "hideWorkspaceButton": true,
  "autoConfigureProfiles": true,
  "compactBottomBar": true,
  "suggestions": "ddg",
  "spaceFolderTitle": "Vivarc"
}
```

- `hideWorkspaceButton`: hide Vivaldi's Workspaces button at the top of the sidebar (on by default).
- `autoConfigureProfiles`: let Vivarc set up profiles created after install (see below).
- `compactBottomBar`: shrink the bottom toolbar (profile button) to Arc's proportions.
- `suggestions`: `"ddg"` sends what you type in the command bar to DuckDuckGo's autocomplete endpoint; `"off"` sends nothing.
- `spaceFolderTitle`: name of the folder created on first run.
- `peek`: `false` keeps the community Peek mod out until you uninstall (uninstall deletes this file). From the next `install` or `apply` on, `install` skips the download and `apply` leaves it out of the bundle even if `~/.vivarc/peek/` is still there. `--no-peek` does the same for one run only, and "Update Vivarc" passes no flags. When Peek is in, it opens on shift+click on a link or a middle-button hold, never on a plain click. Shift+click anywhere else (range selection, extending a text selection) is left to the page. The bundle rewrites Peek's own defaults (alt+click, plus a plain click in pinned tabs and on Google) and leaves Peek out if the downloaded file's text has changed (`PEEK_TRIGGERS` in `vivarc.py`). Peek also reads overrides from a shared config other Awesome-Vivaldi mods can write (`mods.arcPeek` in their `.askonpage/config.json`). Nothing in Vivarc writes it, but another mod that sets `autoOpenList` there brings plain-click Peek back.

`compactBottomBar` and `suggestions` are only the starting values: **Vivarc Settings** (Cmd+T, `settings`) overrides them per profile, live. `01-settings.js` holds the schema (one entry per switch, with the marker class it toggles on `#browser`) and the precedence (saved, then config, then default); `45-settings.js` is the overlay. The `glass` switch only adds the class `vm-glass`, and the `glassOpacity` slider (a `range` entry in the schema, 15 to 95, clamped when read) sets `--vm-glass-opacity` on `#browser`, which every glass fill mixes with; the rules at the end of `vivarc.css` do the rest (the regular variant of Apple's material: blurred, saturated backdrop, translucent fill, specular rim; floating surfaces and the sidebar only, never rows inside them). Vivarc's surfaces sit in Vivaldi's UI layer, where `backdrop-filter` also blurs the page behind floating ones; the sidebar blurs the window background, so it shows real glass over a theme with a background image. `prefers-reduced-transparency` and `prefers-contrast` are supported by Vivaldi's Chromium and switch the surfaces back to solid. Windows of a profile stay in step through a `BroadcastChannel`. Only switches that apply live belong there: anything that writes Vivaldi's Preferences (shortcuts, toolbars) is read at launch, so it stays out.

## What the installer changes

Per Vivaldi profile (`Preferences`): the tab bar goes left; `Cmd+T` is freed from "New Tab" and "Quick Commands" (the command bar listens for it itself);
`Cmd+Shift+C` copies the page URL; `Cmd+S` no longer saves the page: it hides and shows the sidebar of the window it is pressed in, which is Vivarc's own per-window hide (`12-sidebar-hide.js`), not a Vivaldi command (the installer takes `Cmd+S` off every Vivaldi command that holds it, and binds it to none, on every install and update; for a profile set up another way, Vivarc does the same on the profile's first start, once: `05-bootstrap.js` `freeKey`, flag `sidebarKeyFreed`, logging `[vivarc] Ctrl+S freed from <COMMAND>`; Vivaldi reads its key table at startup, so the change is complete from the next start); the `Spacer` and Workspaces items are removed from the tab bar toolbar and the VPN button becomes the Downloads button; the address bar and back/forward/reload move into the sidebar toolbar (the top bar is hidden); the panel icon bar moves to the right and auto-hides (Vivaldi's auto-hide switch is on; the sidebar starts visible, and hiding it is Vivarc's own, not part of the auto-hide switches); the bottom status bar only overlays on hover; the sidebar width starts at 323 unless you set one.
Existing shortcuts are kept. Nothing else in Vivaldi's settings, flags or `Local State` is touched. `uninstall` restores the original values.

## Profiles created later

`install` configures the profiles that exist. For a profile created afterwards, the JS (through `vivaldi.prefs`) applies the same
settings the first time it opens; they take effect immediately, no restart. It also opens the guide page in place of Vivaldi's welcome tab.
`uninstall` finds profiles that carry Vivarc's settings but have no snapshot and resets those keys to Vivaldi's defaults.
Set `"autoConfigureProfiles": false` to skip this and configure profiles only with `install`.

## Files in `~/.vivarc/`

`start/` (guide page), `peek/` (downloaded Peek), `icons.js` (Arc site icons), `import/`, `backup/`, `config.json`, `state.json`.
`apply` refreshes `start/` and rebuilds the bundle (stylesheet included).

## Limits

- Vivaldi profiles are the equivalent of Arc spaces; each is its own window (switch with Cmd+`).
- Vivaldi's own UI code cannot be called from a mod, so Cmd+T opens Vivarc's command bar, not Vivaldi's Quick Commands (Cmd+E and F2 still do).
- macOS only for now.

## Notes for contributors

Things that cost time to find out:

- Vivaldi toolbar buttons are found with `[data-name="<PanelId>"]` (for example `PanelDownloads`), not a `name` attribute.
- They ignore a bare `.click()`. Send `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click` in that order.
- Changing the layout inside a `dragstart` handler makes Chromium cancel the drag. Defer it with `requestAnimationFrame`.
- Re-rendering the sidebar while a drag is running detaches the dragged node. Renders are held back until `dragend`.
- A mod cannot call Vivaldi's own commands or reach its webpack modules; only `chrome.*`, `vivaldi.prefs`, `vivaldi.searchEngines` and `vivaldi.tabsPrivate` are available.
- Enum prefs set through `vivaldi.prefs.set` only take effect live when set by name (`"left"`, `"right"`, `"overlay"`). A number is stored but the UI ignores it until restart. The installer writes numbers because it edits the file while Vivaldi is closed.
- `auto_hide.enabled` is a master switch: when it is on, every bar defaults to hidden unless its own `auto_hide.*` key is explicitly `false`.
- A new profile's welcome tab is `chrome-extension://mpognobbkildjkofajifpdfhcoklimli/components/welcome/welcome.html`, and it can open after the mod has run. "Welcome to Vivaldi" is the start page's title, not the welcome tab's.
- Vivaldi does not write a pref that equals its default, so a key missing from `Preferences` does not mean the set failed.
- Profile switching uses Vivaldi's own UI API, which mods can call: `vivaldi.runtimePrivate.getUserProfiles(cb)` (entries have `name`, `path`, `active`, `guest`, `image`, `customAvatar`), `onProfilesUpdated`, `openNamedProfile(path, cb)` (takes the profile **path**, not the name) and `createProfile(name, imageIndex, createShortcut, cb)`. The chips live in Vivaldi's bottom toolbar (`.toolbar-tabbar-after`), a wrapping flex row that grows to fill the sidebar; its flexible spacers have a minimum width of about the whole sidebar, so the layout rule in `vivarc.css` turns wrapping off and removes that minimum for any toolbar that contains the chips (`:has(> .vm-spaces)`, no class on `#browser`, because Vivaldi rewrites that element's classes). Cmd+Ctrl+Left/Right (previous/next profile, wrapping, by name) and Cmd+Ctrl+1..9 are handled by `06-spaces.js`; `patch_preferences` and the runtime setup in `05-bootstrap.js` free those keys from any Vivaldi command. The account button is removed from `vivaldi.toolbars.tabbar_after` while there are two or more profiles, and the Downloads button is added to every profile.
- A tab belongs to a pin or favorite through two keys Vivarc adds to the tab's `vivExtData` (merged with Vivaldi's own keys, which share the field): `vivarcPin` is the bookmark id and `vivarcHome` is where the pin landed after the site's redirects, so a site that redirects off its root is not shown as away. Vivaldi saves them with the session, so the link survives a restart. Tabs that match a pin by URL when first seen are bound automatically; a key whose bookmark is gone is cleared. The logic is `src/js/08-pins.js`, covered by `tests/test_pins.py` (needs node).
- The Dia layout's Translate button is Vivaldi's own page translation, the calls its address-bar button makes: `vivaldi.tabsPrivate.translatePage(tabId, from, "en", cb)` and `revertTranslatePage(tabId, cb)`. What it shows comes from Vivaldi's translation store (`getPageState(tabId)`: `pageLanguage`, `isTranslated`, `translateStep`), found in the webpack modules as `findRemover` finds its manager (by `VIVALDI_TABS_LANGUAGE_DETERMINED`); `tabsPrivate.onLanguageDetermined`, `onPageTranslated`, `onIsPageTranslatedChanged` and `onShowTranslationUI` say when it changes. Measured on 8.2: Chromium determines a tab's language only once the tab is shown, so a tab loaded in the background has `pageLanguage: ""` and `chrome.tabs.detectLanguage` never resolves for it; a navigation clears the state; after a revert `translateStep` stays `after_translate`, so `isTranslated` is the one to read; translating a page that is already translated shows the original for a moment first; and once a tab has been translated, Chromium translates the next pages in that tab by itself.
- The Dia layout's sidebar button (`#vm-dia-sidebar`) sits in the top row right after Vivaldi's menu button and before Back (just before Back on a Mac, which has no menu button). It calls `window.__vm.sidebarHide.toggle()` (below). Its tooltip follows `sidebarHide.hidden()` through `onChange` and always names Vivarc's own key: `Hide sidebar (Ctrl+S)` / `Show sidebar (Ctrl+S)` (Cmd+S on a Mac).
- `12-sidebar-hide.js` hides the sidebar (Vivaldi's tab bar) in one window: `window.__vm.sidebarHide = { toggle(), hidden(), onChange(fn) }`. Vivaldi's own hide, `COMMAND_MAIN_TOGGLE_TAB_BAR` or its menu, flips the profile-wide pref `vivaldi.tabs.visible` and so hides every window. This is the class `vm-sidebar-hidden` on the window's `#browser` instead (`#browser.vm-on.vm-sidebar-hidden #tabs-tabbar-container { display: none }`), re-applied by the core's marker mechanism when Vivaldi rewrites the class list. The state lives in that window and is not saved. There is no hover slide-in for a hidden sidebar.
  - The key is `window.__vm.shortcut("meta+s")`. Measured on 8.2: `vivaldi.tabsPrivate.onKeyboardShortcut` fires in every window's listener, with the Vivaldi window id the key was pressed in as its first argument (it equals `window.vivaldiWindowId`). The core passes it to subscribers as the third argument, and the module acts only when it matches its own window (`pressedHere`; without both ids it falls back to the window Chromium says is focused).
  - If Vivaldi's own hide has the pref at false, a toggle in a window sets the pref back to true, which shows the sidebar in every window. A per-window show would need every other window to hide itself by class, and could not tell those apart from a window Vivaldi's own menu has just shown.
  - Keys bound to a Vivaldi command run Vivaldi's command and Vivarc hears them too; an unbound key is only heard by Vivarc. Vivaldi reads its key table at startup (measured on 8.2: a bind or unbind made while it runs changed nothing for the next keypress, in old and new windows).
- Split view is Vivaldi's tab tiling, stored in each tab's `vivExtData` JSON as `tiling: {id, layout, type, index}`. A mod can write it with `chrome.tabs.update(id, {vivExtData})`. Measured on the rendered panes: `row` is side by side, `column` is one above the other. Write all tiles at once, and start a fresh `id` for each split: Vivaldi restores tile groups with the session, and reusing an old group keeps its old layout.

## Spaces (Vivaldi workspaces)

- A workspace is `{id, name, emoji, icon}` in the pref `vivaldi.workspaces.list`. Vivaldi reads it once at start-up and writes it back from its own store, so Vivarc only reads it (every 3 s and on tab events) and never writes it; creating one is Vivaldi's own command, bound to `ctrl+meta+n` at install. Events a mod dispatches with `tabsPrivate.onKeyboardShortcut.dispatch` reach other mod listeners but never Vivaldi's shortcut handler (tested with a command that works by hand), so the **+** tile and the *Create New Space* action only show the shortcut.
- A tab's workspace is `workspaceId` in its `vivExtData` JSON (no key means the default space, id 0). `07-workspaces.js` holds the pure logic (tested): which space a tab is in, the list for the space bar, the most recently used tab to switch to, which Pinned folder belongs to which space, where a space lives (`livesIn`), what a tile gesture does (`tileAction`) and the repair plan (`repairPlan`). The sidebar lists only the shown space's tabs, so Clear and Close Other Tabs cannot touch another space.
- **What spaces do is specified in [`vivarc-rules.md`](vivarc-rules.md).** Part 1 is Vivaldi 8.2's measured behaviour, Part 2 the rules Vivarc keeps (invariants, tile gestures and dots, new tabs, favorites and pins, dragging, `Move to <Space>`, repairs, deleting), and Part 3 Byron's decisions. `tools/sandbox-rules.mjs` checks every rule live in a throwaway Vivaldi (`tools/sandbox.ps1`: its own profile, CDP on port 9333). `workspaces.tileAction` decides a tile gesture from Vivaldi's record, and the sidebar's `actOnTile` carries it out. New tabs are left to Vivaldi, which files each one in the window's recorded space.
- `08-space-native.js` exposes Vivaldi's own workspace machinery as `window.__vm.native`:
  - the record of which space each window shows (`findRecord`), the only truth for what a window shows (the active tab stands in only when the record can't be found);
  - the switch `setActiveWorkspace(windowId, workspaceId)` (`findSwitcher`);
  - `PageActions.moveToWorkspace` (`findMover`), behind `Move to <Space>`.

  Each is found in the webpack modules by a marker in its source, kept once found and retried at most every 5 s. Vivaldi's move reports success when it fails, so `moveToSpace` reads the tab again afterwards.
- `11-space-repair.js` carries out the repairs:
  - Every window runs it, but only the leader acts (`workspaces.leaderOf`: the lowest normal window id). It acts 400 ms after the browser settles and re-plans after each pass. After 3 passes that still leave drift, it rests 10 s.
  - Gathers use `chrome.tabs.move`. Their tab ids stay in `window.__vm.movedByVivarc` for 5 s, so the drag restamp skips them.
  - A pull or a move to a new window puts a busy mark on the background page (`__vivarcSpaceGesture`, at most 10 s; `window.html` has no `localStorage`), and repairs wait for it.
  - The drag restamp (`workspaces.restampOnAttach`) runs in the leader 500 ms after an attach, after a closing window has gone.
- Moving a space to a new window: the window opens on `about:blank`, because a start page would open the command bar. Vivaldi's switch may not know a brand-new window yet, so it is retried until the tabs arrive. Then the `about:blank` tab closes.
- New tabs from Ctrl+T, + New Tab and the palette top their space's list, as in Arc (`workspaces.topIndex`). The list shows the highest tab index first.
  - Ctrl+T's blank tab moves there once it has an address.
  - The command bar creates its tab and then moves it, because Vivaldi's `tabs.create` ignores `index`.
  - Never moved: a tab in a folder (moving it would split the stack), a split view's new pane, the page whose address Cmd+L edits, and links a page opens.
- Cmd+Option+Left/Right are bound by `patch_preferences` and `05-bootstrap.js` to Vivaldi's `COMMAND_WORKSPACE_SWITCH_BACK_ORDER`/`_FORWARD_ORDER`, which skip workspaces open in another window and include the default space.
- Pinned folders: bookmark folders that contain a `Pinned` folder are spaces. A workspace takes the folder with its name (case-insensitive, an `Arc - ` prefix ignored); the default space is the first folder no workspace claims. A workspace with no folder gets an empty one when first shown. Favorites always come from the default space's folder. `plan()` in `08-pins.js` receives the pin ids of every space so a tab bound to a pin of another space is never cleared.
- Learned the hard way: Vivaldi normalises a shortcut to the order `ctrl+alt+shift+meta+key` and reads shortcut bindings at launch, so a binding the bootstrap writes live works from the next launch (an install that patches Preferences while Vivaldi is closed works at once). `window.vivaldiWindowId` is not Chrome's window id (`chrome.windows`, `tab.windowId`); every window runs its own copy of the mod, so per-window work (the repairs' leader check, for one) compares `tab.windowId` with `chrome.windows.getCurrent().id`.
- Deleting a space (right-click its tile) calls Vivaldi's own `removeWorkspace`, which also closes the space's tabs. A mod has no API for it, and the webpack chunk array (`webpackChunkgapp_browser_react`) is not on the window the mod runs in: it is on the background page, `chrome.extension.getBackgroundPage()`. `findRemover` pushes a runtime callback onto that array to get webpack's module list, finds the module whose source mentions `removeWorkspace(` and takes the manager from its exports. If a Vivaldi update changes that, the sidebar shows a toast and deletes nothing. Learned by running a second Vivaldi with `--user-data-dir` and `--remote-debugging-port` and calling it from the Chrome DevTools Protocol.
- Workspaces share cookies, IndexedDB and service workers with the rest of the profile. Only a Vivaldi profile isolates logins.
