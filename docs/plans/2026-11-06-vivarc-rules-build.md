# Vivarc Spaces Rules Build: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make Vivarc's spaces and windows behave exactly as `docs/vivarc-rules.md` Part 2 says, with each rule tested.

**Architecture:** the rules are decided by pure functions in `src/js/07-workspaces.js`, tested through `tests/jsrun.py`. They take a snapshot (tabs, windows, Vivaldi's record) and return a decision. A new `src/js/08-space-native.js` is the one place that reaches Vivaldi's internals (record, switch). The sidebar (`10-sidebar.js`), the command bar (`20-command-bar.js`) and a new `src/js/11-space-repair.js` only gather the snapshot, call a pure function and carry out what it returns.

**Tech Stack:** plain browser JS (one bundle, no build step or dependencies), Python 3 unittest/pytest, Node 26 (`jsrun.py`, `search.test.cjs`, CDP probes).

**Spec:** `docs/vivarc-rules.md` (approved, commit fe42a53). Case IDs (A1, B7c, D8…) refer to its Part 1.

## Global Constraints

- **Vivaldi's record is the only truth** for which space a window shows. Read it through `findRecord`. Fall back to the active tab's space only when the record can't be found, and then log one `[vivarc]` warning.
- **No spaces stamped onto new tabs.** Vivarc writes `workspaceId` only in the rules that move a tab into a space on purpose: pins/favorites (Task 5), drag restamp (Task 7) and a tab created as a space's first tab.
- **A plain click never moves tabs between windows.**
- **Vivaldi internals are found through `webpackChunkgapp_browser_react`** on the background page, by source marker, as `findSwitcher` already does: `setActiveWorkspace` for the switch, `getActiveWorkspaceId(e){` for the record. If one isn't found, the feature degrades with a toast or warning. It never throws into the UI.
- **Mac:** the new-window modifier is cmd+shift (`wantsNewWindow`). Nothing may depend on 8.2-only behaviour without a sandbox check on 8.2. 8.3 is checked on the Mac at the end.
- **Tests:**
  - Python, from `tests/`: `PYTHONUTF8=1 python -m pytest -q --ignore test_preflight.py < /dev/null`. Compare the failure **set** against the run before the task; the known Mac-path failures are allowed.
  - JS: `node --test tests/search.test.cjs` must show 52 or more passing and 0 failing.
- **Live checks run only in the sandbox (Task 0).** Never against Byron's Vivaldi, and never on port 9222.
- **Commits:** the repo's configured noreply identity, `feat(spaces): …` / `fix(spaces): …`, with a body saying why. Don't push. The controller pushes after Byron's live test.

## Review Focus

1. **Repairs that set off repairs.** Each repair causes tab events, so the next pass must find nothing left to do, and there are never more than 3 passes. Test: `repairPlan` on the state its own output leaves behind returns `[]` (Task 6).
2. **Every window runs the mod, so repairs could run once per window.** Only `leaderOf(windows)` runs them. Test: one leader for 1, 2 or 3 windows, and a new leader when the leader's window closes (Task 6).
3. **Record not found** (a future Vivaldi renames it). The sidebar, dots and clicks still work from the active tab. Test: `findRecord(fakeChunksWithoutIt)` → `null`, and `tileAction` with an empty record still gives sensible actions (Tasks 1 and 4).
4. **A window close's rehoming mistaken for a drag.** Tabs Vivaldi rehomes on a window close (D2–D8) must not be restamped. Test: `restampOnAttach` returns `null` when the source window is gone (Task 7).
5. **A space deleted while it's shown in another window** (F2). That window ends up on default. Test: `repairPlan` gives `{kind: "switch", window: O, space: 0}` (Task 6).

---

### Task 0: Sandbox with the new code, and the three unconfirmed behaviours

**Files:**
- Create: `tools/sandbox.ps1`. It copies `C:\Program Files\Vivaldi\Application` to `%TEMP%\vivarc-sandbox\app` (skipped if already there), runs `python vivarc.py --app <copy> --data-dir <profile> apply`, and launches the copy with `--user-data-dir=%TEMP%\vivarc-sandbox\profile --remote-debugging-port=9333 --no-first-run --no-default-browser-check`. `-Stop` kills only processes whose command line contains `vivarc-sandbox`. `-Clean` deletes `%TEMP%\vivarc-sandbox`.
- Modify: `docs/vivarc-rules.md`, section "Still to confirm before the tests are written". Replace each item with its measured result and case ID (H1–H3).

The harness is the spike's `lib.mjs`/`cases.mjs`, kept outside the repo at `C:\Users\dicke\AppData\Local\Temp\claude\2a4086a811903c21\164a90c8-3e48-4966-84b5-2d3c3cb97296\scratchpad\spike\`. Copy what you need. Vivarc's settings don't persist in a sandbox (IndexedDB fails there), so set `diaLayout` in each window after it opens.

- [ ] **Step 1:** write `tools/sandbox.ps1`. Run it, and check that `vivarc.js` in the copy's resources holds a marker unique to the working tree (e.g. `findRecord` once Task 1 lands; for now `spaceToNewWindow`). Check that `Get-CimInstance Win32_Process` shows Byron's own Vivaldi PIDs untouched.
- [ ] **Step 2, H1:** in the sandbox, with W showing X and a parked Y tab in W, activate that Y tab through Vivaldi's own UI: a CDP mouse click on the tab in Vivaldi's tab strip (switch the Arc layout off so Vivaldi's tab bar shows), and Vivaldi's window panel. Record whether the record follows (switch) or stays (G1).
- [ ] **Step 3, H2:** drag a tab from W's Vivaldi tab strip into O with CDP `Input.dispatchDragEvent`/mouse events on the UI target. If that can't be driven, call `vivaldi.tabsPrivate.move` the way Vivaldi's own drag code does (find it in bundle.js by searching `PageActions.moveToWindow`/`tabsPrivate.move`) and say which you used. Record the tab's space and both records afterwards.
- [ ] **Step 4, H3:** create a pinned bookmark in space X's Pinned folder, open it (it binds a tab), switch the window to Y, click the pin. Record whether Vivarc activates the X tab (G1 drift).
- [ ] **Step 5:** write the results into the rules doc and commit `tools/sandbox.ps1` and the doc: `docs(spaces): confirm tab-bar clicks, drag and pins in the sandbox`. If a result contradicts a rule in Part 2, stop and report to the controller before Task 1.

### Task 1: Read Vivaldi's record

**Files:**
- Modify: `src/js/07-workspaces.js` (add `findRecord`, export it)
- Create: `src/js/08-space-native.js`
- Modify: `src/js/10-sidebar.js` (`loadTabs`, `nativeSwitcher`)
- Test: `tests/test_space_rules.py` (new; same `run_js` style as `tests/test_workspaces.py`)

**Interfaces:**
- Produces: `workspaces.findRecord(chunks) -> {activeIn(windowId): number, all(): Map<number, number>} | null`. `activeIn` returns 0 for the default space. `all()` maps spaceId → windowId.
- Produces: `window.__vm.native = { record(): {activeIn, all} | null, switchTo(windowId, spaceId): Promise<void>, focus(windowId): Promise<void> }`. Lookups are cached after the first success and retried at most every 5 s while missing. `switchTo(w, 0)` passes `undefined` to Vivaldi.
- Produces: `state.active` in the sidebar = `native.record()?.activeIn(ownWindow)`, falling back to `workspaces.activeId(tabs)`.

- [ ] **Step 1: failing tests** in `tests/test_space_rules.py`, class `Record`. Fake chunks follow `TranslationState.FAKE` in `tests/test_dia.py`; the store's source contains `getActiveWorkspaceId(e){`.
  - `test_the_record_says_which_space_a_window_shows`: `findRecord(chunks).activeIn(7) == 42`, and `activeIn(8) == 0` for a window with no entry.
  - `test_all_maps_each_space_to_its_window`: `[...all()]` = `[[42, 7]]`.
  - `test_no_store_means_no_record_not_an_error`: `findRecord(undefined) is None`, and same for chunks without the marker.
- [ ] **Step 2:** run them and see them fail (`findRecord` undefined).
- [ ] **Step 3:** implement `findRecord` in 07 with the `findSwitcher` pattern. Create `08-space-native.js` with `window.__vm.native`. Point the sidebar's `nativeSwitcher` at `native.switchTo`, and set `state.active` from the record in `loadTabs`.
- [ ] **Step 4:** tests pass, the full suites match the baseline, and `node --check` passes on the three files.
- [ ] **Step 5:** commit `feat(spaces): read which space a window shows from Vivaldi's own record`.

### Task 2: Stop stamping new tabs

**Files:**
- Modify: `src/js/07-workspaces.js` (remove `stamp`), `src/js/10-sidebar.js` (remove the `chrome.tabs.onCreated` stamping listener near the `ownWindow` block), `src/js/20-command-bar.js` (`openNew` creates `{ url }` only, then `toTop`)
- Test: `tests/test_workspaces.py` (remove the `NewTabs` stamp tests), `tests/search.test.cjs` (expect `{ url: 'https://google.com.au' }` again), `tests/test_space_rules.py`

**Interfaces:**
- Consumes: Vivaldi files every new tab in the window's recorded space (B1, B2b, B7c).

- [ ] **Step 1: failing test** `test_vivarc_never_writes_a_space_onto_a_new_tab` in `tests/search.test.cjs` style: drive `openNew` via the bar (as the existing "Enter goes to a typed address" test does) with active tab 10 in space 1, and assert that `calls.navigation.at(-1)` deep-equals `{ url: 'https://google.com.au' }`. Also add a Python test asserting `'stamp' not in workspaces exports`, so it fails now.
- [ ] **Step 2:** run them and see them fail.
- [ ] **Step 3:** remove `stamp`, its listener and `openNew`'s `vivExtData`. Keep `toTop` (it reads the tab's space after creation, which Vivaldi has stamped by then; B1).
- [ ] **Step 4:** suites as baseline (minus the removed stamp tests) and JS 52/52.
- [ ] **Step 5:** commit `fix(spaces): new tabs take the window's space from Vivaldi, not from Vivarc`. Say in the body that this fixes A8b.

### Task 3: Where a space lives, and the dots

**Files:**
- Modify: `src/js/07-workspaces.js`: add `livesIn` and `dotsFor`, change `tileHint`, remove `elsewhere` and `activeWindowOf`
- Modify: `src/js/10-sidebar.js`: `readElsewhere`/`checkElsewhere` become `readDots`/`checkDots` (same debounce and only-on-change behaviour); `spacePill` uses `dotsFor`
- Test: `tests/test_space_rules.py` class `LivesIn`, and update `TileHint` in `tests/test_workspaces.py`

**Interfaces:**
- Produces: `workspaces.livesIn(tabs, record: Map, id) -> windowId | null`, where `tabs` is all tabs in all normal windows. The rule: the window the record shows it in; otherwise the window holding the most tabs of `id` (on a tie, the lowest window id); otherwise `null`. `id` 0 → `null`.
- Produces: `workspaces.dotsFor(tabs, record, here) -> number[]`: the space ids whose `livesIn` is a window other than `here`, sorted.
- Produces: `workspaces.tileHint(item, livesElsewhere: boolean, windows = window.__vm.windows) -> string`. The default and plain copy stay as they are. When it lives elsewhere: `` `${name} · lives in another window. Click to go there, shift+click to bring it here, ${ctrl|cmd}+shift+click to move it to a new window` ``.

- [ ] **Step 1: failing tests:**
  - `test_shown_in_a_window_lives_there`;
  - `test_parked_lives_where_its_tabs_are`;
  - `test_split_lives_where_it_is_shown_else_with_most_tabs_ties_to_lowest_window`;
  - `test_no_tabs_lives_nowhere`;
  - `test_the_default_space_lives_nowhere`;
  - `test_dots_are_spaces_living_in_other_windows_shown_or_parked`;
  - the updated `TileHint` text test.
- [ ] **Step 2:** they fail.
- [ ] **Step 3:** implement and wire the sidebar. The tabs come from `chrome.tabs.query({ windowType: "normal" })`, the record from `native.record()?.all() ?? new Map()`.
- [ ] **Step 4:** pass, suites as baseline.
- [ ] **Step 5:** commit `feat(spaces): a dot means the space lives in another window, shown or parked`.

### Task 4: The tile gestures

**Files:**
- Modify: `src/js/07-workspaces.js`: add `tileAction`
- Modify: `src/js/10-sidebar.js`: `switchSpace`/`pullSpace`/`spaceToNewWindow` become one `actOnTile(item, event)` that gathers the snapshot, calls `tileAction` and carries it out. The `pulling` guard expires after 10 s, and a click it ignores shows the toast "Still moving a space…".
- Test: `tests/test_space_rules.py` class `TileGestures`, one test per row of the spec's gesture table

**Interfaces:**
- Consumes: `livesIn`, `wantsNewWindow`, `native`.
- Produces: `workspaces.tileAction({ id, here, tabs, record, shift, newWindow }) -> { kind: "none"|"show"|"focus"|"show-there"|"pull"|"new-window", window?: number }`. Carrying it out:
  - `show` → `switchTo(here, id)`;
  - `focus` → `focus(window)`;
  - `show-there` → `switchTo(window, id)` then `focus(window)`;
  - `pull` → `switchTo(livesIn, 0)` if it is shown there, then `switchTo(here, id)`;
  - `new-window` → the existing `spaceToNewWindow` flow, with its holder taken from the record.

- [ ] **Step 1: failing tests.** One per row, each asserting the exact `{kind, window}`:
  - shown here: click `none`, shift `none`, new-window `new-window`;
  - shown in W2: click `{focus, 2}`, shift `pull`;
  - parked here: click `show`, shift `show`;
  - parked in W2: click `{show-there, 2}`, shift `pull`;
  - split, shown in W2: click `{focus, 2}`;
  - split, shown nowhere, most tabs in W2: click `{show-there, 2}`;
  - empty: click `show`, new-window `new-window`;
  - default space: click `show` (`none` when here already shows default), new-window `none`;
  - record missing (an empty Map) and the tabs say it's active here: click `none`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3:** implement `tileAction` and `actOnTile`. Carrying out `show-there` must focus the other window *after* the switch (A10: the switch doesn't focus).
- [ ] **Step 4:** pass, suites as baseline.
- [ ] **Step 5:** commit `feat(spaces): a plain click goes to where a space lives and never moves tabs`.

### Task 5: Favorites and pinned tabs open in the space on screen

**Files:**
- Modify: `src/js/07-workspaces.js`: add `pinAction`
- Modify: `src/js/10-sidebar.js` `focusOrOpen` (around line 108)
- Test: `tests/test_space_rules.py` class `Pins`

**Interfaces:**
- Produces: `workspaces.pinAction(boundTab | null, here, shown) -> { kind: "activate"|"bring"|"open", tab?: number }`:
  - bound tab in `here` and in space `shown` → `activate`;
  - bound tab elsewhere (another space, or another window) → `bring`: move it to `here` (`chrome.tabs.move`, index -1), write `workspaceId` = `shown` (remove the key when `shown` is 0), then activate;
  - no bound tab → `open` (today's `openPin`).

- [ ] **Step 1: failing tests:**
  - `test_a_pin_open_in_this_space_is_just_activated`;
  - `test_a_pin_parked_in_another_space_is_brought_into_the_space_on_screen`;
  - `test_a_pin_in_another_window_is_brought_here`;
  - `test_an_unopened_pin_opens_a_tab`;
  - `test_bringing_into_the_default_space_removes_the_key`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3:** implement and wire `focusOrOpen`. Restamp first, then activate, so the record never sees a tab of another space become active (G1).
- [ ] **Step 4:** pass, suites as baseline. Confirm in the sandbox that the H3 scenario from Task 0 now keeps record and screen in agreement.
- [ ] **Step 5:** commit `fix(spaces): favorites and pins open in the space on screen`.

### Task 6: Repairs

**Files:**
- Modify: `src/js/07-workspaces.js`: add `repairPlan` and `leaderOf`
- Create: `src/js/11-space-repair.js`
- Test: `tests/test_space_rules.py` class `Repairs`

**Interfaces:**
- Produces: `workspaces.leaderOf(windows) -> windowId | null`: the lowest id among `type === "normal"` windows.
- Produces: `workspaces.repairPlan({ windows, tabs, record: Map, spaces: number[] }) -> Array<{kind: "switch", window, space} | {kind: "activate", tab} | {kind: "gather", space, window, tabs: number[]}>`. Rules in the spec's order:
  1. A record entry whose space isn't in `spaces`, or whose window holds no tab of that space → `switch` that window to 0.
  2. A window whose active tab's space ≠ its recorded space:
     - it holds a tab of the recorded space → `activate` the most recent (`lastAccessed`) one;
     - otherwise, the active tab's space is shown in another window → `switch` to 0;
     - otherwise → `switch` to the active tab's space.
  3. A named space with tabs in more than one window → `gather` the stray tab ids into `livesIn(...)` (the shown window, otherwise most tabs).
  - Rule 1 also covers decision 2: rehomed tabs stay parked where they landed.
- Produces: `11-space-repair.js`.
  - In the leader window only, it listens to `tabs.onActivated`/`onAttached`/`onDetached`/`onRemoved`, `windows.onRemoved` and the workspace list changing (the existing 3 s poll's comparison), and runs once at start-up.
  - It debounces 400 ms, snapshots, plans and carries the plan out:
    - `switch` → `native.switchTo`;
    - `activate` → `chrome.tabs.update(active)`;
    - `gather` → `chrome.tabs.move(tabs, {windowId, index: -1})`, with those ids recorded in `window.__vm.movedByVivarc`.
  - It re-plans after each pass, for at most 3 passes, and logs `[vivarc] repair: …` per action.

- [ ] **Step 1: failing tests**, one per rule plus the Review Focus items:
  - `test_a_window_on_a_deleted_space_goes_to_default` (F2);
  - `test_a_window_with_no_tab_of_its_space_goes_to_default` (C3, D1);
  - `test_an_active_tab_of_another_space_hands_back_to_the_recorded_space` (G1);
  - `test_with_no_tab_of_the_recorded_space_the_record_follows_the_active_tab`;
  - `test_but_not_onto_a_space_shown_in_another_window` (G6);
  - `test_a_split_space_is_gathered_where_it_is_shown` (D8);
  - `test_a_split_space_shown_nowhere_gathers_where_most_tabs_are`;
  - `test_a_consistent_state_needs_no_repair`;
  - `test_the_state_a_plan_leaves_needs_no_further_repair` (apply the plan to the snapshot in the test, then re-plan → `[]`);
  - `test_one_leader_the_lowest_normal_window`;
  - `test_a_closed_leader_is_replaced`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3:** implement both pure functions and the runtime module.
- [ ] **Step 4:** pass, suites as baseline. Then, in the sandbox, reproduce D8, F2, C3 and G1 and confirm that within 2 s the invariants hold: snapshot record == active tab's space in every window, and no named space in more than one window.
- [ ] **Step 5:** commit `feat(spaces): repair the record, the screen and split spaces when Vivaldi lets them drift`.

### Task 7: A dragged tab joins the space it lands in

**Files:**
- Modify: `src/js/07-workspaces.js`: add `restampOnAttach`
- Modify: `src/js/11-space-repair.js`: on `onAttached` in any window (the leader handles it), after 500 ms, compute and write
- Test: `tests/test_space_rules.py` class `Drag`

**Interfaces:**
- Produces: `workspaces.restampOnAttach({ tab, shownSpace, sourceWindowOpen: boolean, movedByVivarc: boolean }) -> string | null`. It returns the new `vivExtData` (with `workspaceId` = `shownSpace`, or the key removed for 0) only when `sourceWindowOpen && !movedByVivarc && of(tab) !== shownSpace`, else `null`.

- [ ] **Step 1: failing tests:**
  - `test_a_tab_dragged_into_a_window_joins_its_space`;
  - `test_into_the_default_space_the_key_is_removed`;
  - `test_a_tab_rehomed_by_a_window_close_keeps_its_space` (source window gone);
  - `test_a_tab_vivarc_moved_keeps_its_space`;
  - `test_a_tab_already_in_that_space_is_left_alone`.
- [ ] **Step 2:** they fail.
- [ ] **Step 3:** implement and wire. Track open windows with `windows.onRemoved`, and the source window with `onDetached(oldWindowId)`.
- [ ] **Step 4:** pass, suites as baseline. In the sandbox, H2's drag joins the target space, and D2's window close keeps the spaces.
- [ ] **Step 5:** commit `feat(spaces): a tab dragged into another window joins the space it shows`.

### Task 8: Deleting a space tells the whole story

**Files:**
- Modify: `src/js/07-workspaces.js` `removalLabel`, and `src/js/10-sidebar.js` around line 873
- Test: `tests/test_workspaces.py` `DeleteSpace` (update the existing label tests)

**Interfaces:**
- Produces: `workspaces.removalLabel(name, tabCount, windowCount, closesWindow: boolean) -> string`. The copy:
  - `Delete “X”` when there are no tabs;
  - `Delete “X” and close its N tab(s)` when they're in one window;
  - with `in M windows` appended when there's more than one;
  - with `. A window holding only these tabs closes too` appended when `closesWindow`.
  - `closesWindow` = a normal window whose every tab is in X (F3).

- [ ] **Step 1: failing tests** for the four copy forms.
- [ ] **Step 2:** they fail.
- [ ] **Step 3:** implement. The sidebar counts across all normal windows. The F2 aftermath is left to Task 6's repair 1.
- [ ] **Step 4:** pass, suites as baseline.
- [ ] **Step 5:** commit `feat(spaces): the delete confirmation counts tabs in every window`.

### Task 9: Docs, and the whole rule set in the sandbox

**Files:**
- Modify: `docs/HOW-IT-WORKS.md` "Spaces" section: replace the switching, dots, pull, new-window and new-tab bullets with a short summary that points to `docs/vivarc-rules.md`. Keep the implementation notes (`findSwitcher`, the webpack lookup, the shortcut notes).
- Modify: `CHANGELOG.md` Unreleased: one line per user-visible change from Tasks 2–8, replacing the earlier spaces lines that no longer hold.
- Create: `tools/sandbox-rules.mjs`. For each gesture-table row, repair and decision in the spec, it sets up the state in the sandbox, acts, waits until things settle (as in the spike) and asserts the expected snapshot and the two invariants. It prints one PASS/FAIL line per rule ID.

- [ ] **Step 1:** write `tools/sandbox-rules.mjs` against the spec's case IDs. Run it on the old code first: copy the app afresh at commit `fe42a53` with `tools/sandbox.ps1`, and confirm it FAILs at least the A8b, G1, D8 and gesture "parked in W2" rows (proof that it can see the bugs).
- [ ] **Step 2:** re-run `tools/sandbox.ps1` against the working tree and run the script. Every rule passes in Dia, and the gesture rows also pass in Arc.
- [ ] **Step 3:** update the docs. Run the full suites one last time.
- [ ] **Step 4:** commit `docs(spaces): point HOW-IT-WORKS at the rules; sandbox checks for every rule`. Run `tools/sandbox.ps1 -Stop` and `-Clean`.
