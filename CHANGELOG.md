# Changelog

## Unreleased
- Fix: Vivaldi's right-hand panel (auto-hidden) slides in from the window's right edge on every monitor, not only on one with nothing to its right. Vivaldi only reacts to the pointer in the window's last 4 px, and only while the pointer is over the window, so where another monitor sits to the right the pointer usually passed that strip without stopping. Vivarc now also watches the gap at the window's right edge (6 px, 8 px in the Dia layout), in the window's own coordinates, and asks Vivaldi to show the panel there, with Vivaldi's own checks. Rest the pointer in that gap. In the Arc layout a maximised window keeps a 6 px gap at the right (as an unmaximised one already has), so the page's scrollbar is never under the edge.
- Fix: clicking a tab no longer pops Vivaldi's hidden address field open over the sidebar. A tab left with the cursor in the address field (Ctrl+L, then a switch) used to put it back there on every return; when that happens just after a tab switch and you did not ask for the field (no Ctrl+L, Cmd+L or F6, no click on it, no typed text, no permission popup), the page gets the cursor instead.
- **Mute a tab**: right-click a tab row for **Mute Tab** / **Unmute Tab**. A tab playing sound shows a small speaker before its name: click it to mute. A muted tab shows a crossed-out speaker in place of its favicon: click it to unmute. Pinned rows work the same, and a muted favorite's tile carries a small crossed-out speaker over its corner. Mute All Tabs shows on the rows too.
- **Clean Up Tabs** in the New Tab dropdown closes the tabs of the space on screen that you have not used for 7 days, then offers **Undo** in a toast. **Clean Up Daily** (a ✓ toggle in the same menu, and in Vivarc Settings; off by default) does it once a day for every space in every window, quietly. Pinned tabs, favorites, the tab on screen in any window (and the tabs beside it in a split view), tabs playing sound and private-window tabs are never cleaned; tabs in folders are. A tab only closes once its entry is confirmed in Recently Cleaned, so a run bigger than the list's 200 leaves the rest open. Cleaned tabs wait in **Recently Cleaned** for 30 days (up to 200): click one to reopen it in its space, or Clear list.
- The New Tab dropdown's confirmations (Close All Tabs, Clear list) open with Cancel under the pointer, so a double-click cannot confirm. The chevron's highlight goes out whenever the menu closes, Mute All Tabs carries on past a tab that cannot be muted and says how many failed, and picking a tab in a minimised window brings that window back.
- A dropdown on the **+ New Tab** row: hover it and a chevron shows at the right; the rest of the row still opens the command bar. The menu has Search Tabs, an Open Tabs list (every window, by space), Recently Closed tabs, Recently Closed Windows, Mute/Unmute All Tabs and Close All Tabs (asks first; the same tabs the Clear button closes). Lists open as side flyouts.
- Fix: on a Mac, with the Dia layout and the sidebar hidden, the top row starts after the traffic lights instead of running under them, with the room Vivaldi itself leaves for them. The strip beside them still drags the window.
- Dia layout: a **Translate** button left of Copy link, on pages that are not in English. It translates the page into English in place with Vivaldi's own translation, which the Dia layout otherwise hides with the address bar. Once the page is translated, the button says **Show original**.
- Ctrl+shift+click a space tile (cmd+shift+click on a Mac) to move the space to a new window of its own, the reverse of shift+click's "bring it here".
- Drag a tab from one window's sidebar into another window's sidebar: it moves there, at the drop position, into the space that window shows, and becomes the active tab. The window you dragged from keeps showing its space. The middle of a row counts as its nearer edge: no folder is made across windows.
- Drag a tab out of the sidebar, past the window's edge, to open it in a new window. The tab goes into that window's default space and leaves its space; the window you dragged from keeps showing its space. Pins, favorites and folders stay, and so does a window's only tab. A drop onto another window's page also opens the new window. Escape does not cancel a drag that has left the window, so a toast offers **Undo** for 5 seconds (it puts the tab back, in its space; a split view or folder is not restored). A tab in a split view leaves it, and so do its partners.
- A git clone of Revival Arc is no longer offered upstream's releases by the update reminder: it updates with `git pull` from its own fork. The "Vivaldi was updated" reminder stays.
- A space that lives in another window has a dot on its tile, whether it is shown there or parked there. Before, only a space shown in another window had one. The default space's tooltip says it holds this window's own tabs.
- Clicking a space tile goes to where the space lives. A space shown in another window brings that window to the front. A space parked in another window is shown there, and that window comes to the front. Before, its tabs were pulled into this window. A plain click no longer moves tabs between windows, except to gather a space split across windows into the window it lives in. Shift+click still brings a space here.
- New tabs, links included, open in the space on screen, which is how Vivaldi files them. Vivarc no longer stamps new tabs itself. Its stamping could undo a switch to the default space and file the next tab in the old one.
- New tabs from Ctrl+T, + New Tab and the command bar open at the top of the space's list, as in Arc. Links opened from a page still open next to it.
- Fix: clicking a favorite or a pinned tab whose tab is in another space or window brings that tab here, into the space on screen. Before, a second tab opened.
- Vivarc puts things right when Vivaldi lets them drift:
  - A window left on a deleted space, or on a space it has no tab of, goes to its default space.
  - A window that shows a tab of one space while Vivaldi records it on another is put back in step.
  - A space split across windows, for example after a window closes, is gathered into one window.
- A tab dragged into another window joins the space that window shows. That is Vivaldi's own behaviour; Vivarc adds nothing. Tabs rehomed from a closing window keep their space.
- Picking a tab of another space in the command bar shows that space, with the tab on screen. Before, the window could jump straight back to the space it was on.
- Deleting a space: the confirmation counts the space's tabs in every window, and says when a window holding only those tabs will close too.
- Right-click a tab in the sidebar and pick **Move to <Space>** to move it to another space, with Vivaldi's own move. The window stays on the space it shows. If the space is shown in another window, the tab goes to that window. A space parked in another window is refused with a message: show it in its window first.
- The sidebar hides in one window at a time. Ctrl+S (Cmd+S on a Mac) hides and shows the sidebar of the window you press it in, in both layouts, and the Dia layout's new button in the top row, between Vivaldi's menu button and Back, does the same. Other windows keep theirs. Before, the hide was Vivaldi's own, one setting for every window at once.
- Ctrl+S is now Vivarc's. On a profile's first start after this, Vivarc takes the key off whatever Vivaldi command holds it (the tab bar's hide, its auto-hide, Save Page) and says so in the console, once. Vivaldi reads its keys at startup, so quit and reopen it once after that start. A hidden sidebar no longer slides back in when you move the pointer to the left edge of the window; press Ctrl+S (or the Dia button) to bring it back.
- Peek opens on shift+click on a link (or a middle-button hold) and never on a plain click. Before, alt+click opened it, and so did a plain click in pinned tabs and on Google pages. Shift+click on a link opens Peek instead of a new window. `"peek": false` in `~/.vivarc/config.json` keeps Peek out, including after "Update Vivarc", and the Windows re-apply task now puts Peek back unless it is turned off.
- Pinned folders slide open and shut instead of appearing at once. With Reduce Motion on, they still open instantly.

## 0.1.16 - 2026-10-28
- **Uninstall Vivarc**: the installer now also leaves `~/Applications/Uninstall Vivarc.app` next to Update Vivarc. It quits Vivaldi, restores your settings, removes Vivarc and reopens Vivaldi, so removing or reinstalling no longer needs Terminal.
- Docs: the README and the guide page now say that a sidebar hidden with Cmd+S slides back in when you move the pointer to the left edge of the window.

## 0.1.15 - 2026-10-27
- Right-click a space tile and pick **Delete Space…** to remove it; a second step asks first and says how many tabs will close. The space's Pinned folder stays in your bookmarks and comes back if you create a space with the same name. The default space cannot be deleted.

## 0.1.14 - 2026-10-27
- The update reminder also tells you when a new Vivarc release is out: one dialog per release, and on yes it runs Update Vivarc. It needs the reminder to be on (`reminder on`).

## 0.1.13 - 2026-10-27
- Fix: sites could not ask for the camera or microphone (Google Meet's "Allow" did nothing). Vivaldi shows these requests under the address bar, which Vivarc keeps collapsed, so they were invisible. The address bar now floats over the sidebar, as with Cmd+L, while such a popup is open, and is no longer cut off by the page when a theme is on.
- **Liquid glass** (off by default; turn it on in Vivarc Settings): a translucent, blurred sidebar, menus, command bar and dialogs, following Apple's Liquid Glass guidance (glass only for navigation and controls, never stacked, legible text) and falling back to solid surfaces when macOS has Reduce Transparency or Increase Contrast on. A **Glass opacity** slider in the settings goes from clear to frosted.
- **Vivarc Settings**: Cmd+T, type `settings`, or right-click the sidebar and pick Vivarc Settings… to switch features on and off live: the space bar, the compact bottom bar and search suggestions. Saved per profile and applied in all of the profile's windows; `~/.vivarc/config.json` still sets the starting values.
- Cmd+T quick actions **Collapse All Folders** and **Expand All Folders** fold or unfold every pinned folder in the sidebar at once (type `collapse`, `expand` or `folders`).

## 0.1.12 - 2026-10-26
- Spaces: Vivaldi workspaces become Arc-style spaces. A row of emoji tiles under the sidebar switches between them; each space lists only its own tabs (Clear and Close Other Tabs stay inside it) and has its own Pinned folder, named after the workspace (an imported `Arc - Work` folder goes with a workspace called Work, and a new workspace gets an empty one). Favorites are shared by every space, and a tab you open (command bar, link, sidebar) stays in the active space. A space only groups tabs: logins are shared, profiles remain the way to separate them.
- Cmd+Option+Left/Right now switches to the previous/next space (Vivaldi's own workspace commands). The profile switcher's previous/next moves to Cmd+Ctrl+Left/Right; Cmd+Ctrl+1..9 is unchanged.
- **Ctrl+Cmd+N** opens Vivaldi's Create Workspace dialog (name, icon or emoji). The **+** tile under the sidebar and **Create New Space** in the Cmd+T bar remind you of it: a mod cannot press a shortcut for you.

## 0.1.11 - 2026-10-24
- Right-click a favorite or a pinned tab and pick Rename… to change its name. A favorite's name is edited in a field under its row (the tile only shows the icon); Enter saves, Escape cancels.
- Fix: some favorites (Gmail for example) showed a letter instead of their icon after restarting Vivaldi, until they were opened again. Large favicons are now shrunk to 64px before being cached, instead of not being cached at all.
- Profile switcher: the bottom bar shows your Vivaldi profiles as round avatars in place of the account button. Click one to open or focus that profile, or press Cmd+Ctrl+1..9. A **+** creates a new profile and right-clicking your own avatar opens Vivaldi's profile manager.
- Cmd+Option+Left/Right switches to the previous/next profile, like Arc's spaces (it replaces Vivaldi's own use of that combo for switching tabs; Ctrl+Tab still cycles tabs).
- Every profile now gets the Downloads button in the bottom bar (profiles without Vivaldi's VPN button never had it).

## 0.1.10 - 2026-10-24
- Fix: with a theme on, the hidden sidebar (Cmd+S) still could not be clicked when it slid back in on hover.

## 0.1.9 - 2026-10-24
- Fix: with the sidebar hidden (Cmd+S), nothing in it could be clicked when it slid back in on hover.

## 0.1.8 - 2026-10-24
- The favorites grid shrinks its tiles (down to 72px) before dropping a column, instead of jumping straight from 3 to 2 columns.
- The sidebar can no longer be resized below 220px.

## 0.1.7 - 2026-10-23
- Like Arc, a pinned tab stays on its pin when you navigate inside it, instead of turning into a separate open tab and leaving the pin looking closed. The row shows a `/` and the current page's title (the pin's name is in the tooltip); hover it for "Back to pinned page" and "Separate From Pinned Tab" (also in the right-click menu, and for favorites). The link is stored in the tab's session data, so it survives a restart.
- Behaviour change: only the tab bound to a pin is hidden from the open tabs list. A second tab on the same site now shows up as a regular tab.

## 0.1.6 - 2026-10-23
- Update Vivarc is now a real app (`~/Applications/Update Vivarc.app`) that you can drag to the Dock; it opens the update script in Terminal. The plain script moved to `~/.vivarc/` and the old one in `~/Applications` is removed on the next install.

## 0.1.5 - 2026-10-23
- Fix: the installer's questions ("Quit Vivaldi now?", the App Management "press Enter" step) never reached the terminal and always fell through to "nothing was changed". They now work.
- `update` (and so Update Vivarc and the reminder) closes Vivaldi by itself, and the Update Vivarc script reopens it afterwards, also when the update fails.

## 0.1.4 - 2026-10-23
- Optional update reminder: `install` asks once; when a Vivaldi update has removed Vivarc, a dialog offers to bring it back (opens Update Vivarc). Turn it on or off with `reminder on|off`; `uninstall` removes it.

## 0.1.3 - 2026-10-23
- `update` command: fetches the latest release (or pulls a git checkout) and re-applies it. The installer leaves a double-clickable "Update Vivarc" in your Applications folder that runs it after a Vivaldi update and reopens Vivaldi. `uninstall` removes it. If you are on 0.1.2, paste the install line once to get it.

## 0.1.2 - 2026-10-23
- One-line installer for everyone (also updates and repairs): downloads the latest release and runs it, no git needed.
- The installer checks that macOS allows editing Vivaldi before changing anything, opens the App Management settings page and waits, offers to quit Vivaldi, refuses to run as root, and detects files left owned by root after an earlier sudo run.
- `apply` works while Vivaldi is open; the bundle is written atomically.

## 0.1.1 - 2026-10-23
- Fix: the sidebar could stay empty after a restart when tab events cancelled the first bookmark load.
- Added a contributing guide, issue templates and a demo GIF in the README.
- Quick actions Split View: Side by Side, Split View: Top and Bottom and Close Split View, built on Vivaldi's tab tiling. A split tab shows a ◫ mark in the sidebar.

## 0.1.0 - 2026-10-23
- Sidebar: favorites grid, pinned folders, divider with Clear, open tabs in one scrollable panel.
- Drag and drop between favorites, pinned folders and open tabs; context menus; inline folder rename.
- Command bar on Cmd+T: tabs, bookmarks, history, URLs, search suggestions, `yt` + Tab engine mode.
- Cmd+Shift+C "Copied Current URL" toast.
- Theme editor: sidebar colour, shade and grain, saved per profile.
- Layout applied to every profile: address bar and back/forward/reload inside the sidebar toolbar, profile and Downloads buttons at the bottom, panel bar on the right with auto-hide, status bar in overlay mode, sidebar width 323.
- First run of a profile: starter favorites (Gmail, Calendar, Drive, YouTube, GitHub, Maps) and example pins (a link, a folder, a nested folder); the guide page replaces Vivaldi's welcome tab.
- Quick actions in the command bar, 18 built-in search shortcuts, Cmd+S sidebar toggle, Downloads button, guide page.
- Profiles created after install are set up automatically, live (no restart). The stylesheet is embedded in the injected script: no CSS-mods folder or Vivaldi flags.
- Installer with backups, per-profile snapshots, uninstall; Arc importer (spaces to bookmarks, site icons).
- Optional Peek link preview, downloaded from upstream at a pinned commit.
